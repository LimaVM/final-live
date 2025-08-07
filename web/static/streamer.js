// DevLima MotoStream - Script do Streamer (Go Backend)
// Implementação WebRTC otimizada para resolver problemas de conexão

console.log('🎥 DevLima MotoStream Streamer - Iniciando...');

// Elementos da interface
const localVideo = document.getElementById('localVideo');
const localWrapper = document.getElementById('local-wrapper');
const videoPlaceholder = document.getElementById('video-placeholder');
const connectionStatus = document.getElementById('connection-status');
const shareButton = document.getElementById('share-button');
const shareUrl = document.getElementById('share-url');
const cameraSwitch = document.getElementById('camera-switch');
const qualitySwitch = document.getElementById('quality-switch');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const viewerCount = document.getElementById('viewer-count');
const duration = document.getElementById('duration');

// Configuração
const liveId = window.location.pathname.split('/')[2];
const urlParams = new URLSearchParams(window.location.search);
const cameraOption = urlParams.get('camera') || 'user';

// WebSocket e WebRTC
const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProtocol}://${window.location.host}/ws`;
const wsUrlFallback = `ws://${window.location.host}/ws`;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 10
};

// Estado global
let ws = null;
let localStream = null;
let peerConnections = new Map(); // Múltiplas conexões para múltiplos espectadores
let isStreaming = false;
let startTime = null;
let durationInterval = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// Qualidades de vídeo
const videoQualities = {
    '480p': { width: 854, height: 480, frameRate: 30 },
    '720p': { width: 1280, height: 720, frameRate: 30 },
    '1080p': { width: 1920, height: 1080, frameRate: 30 }
};

// Inicialização
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('🚀 Inicializando streamer...');
        await initializeStreamer();
    } catch (error) {
        console.error('❌ Erro ao inicializar:', error);
        updateConnectionStatus('disconnected', 'Erro fatal');
        alert('Erro ao inicializar. Recarregue a página.');
    }
});

async function initializeStreamer() {
    // Configura interface
    setupInterface();
    
    // Captura mídia local
    await getLocalStream();
    
    // Conecta ao servidor
    await connectToServer();
    
    // Inicia transmissão
    await startStreaming();
    
    console.log('✅ Streamer inicializado com sucesso');
}

function setupInterface() {
    // URL de compartilhamento
    const viewerUrl = `${window.location.origin}/live/${liveId}`;
    shareUrl.value = viewerUrl;
    
    // Botão de copiar
    shareButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(viewerUrl);
            shareButton.textContent = '✓ Copiado!';
            shareButton.style.background = '#2ed573';
            setTimeout(() => {
                shareButton.textContent = 'Copiar';
                shareButton.style.background = '';
            }, 2000);
        } catch (error) {
            shareUrl.select();
            alert('Link selecionado! Use Ctrl+C para copiar.');
        }
    });
    
    // Seletor de câmera
    cameraSwitch.value = cameraOption;
    cameraSwitch.addEventListener('change', async (e) => {
        await switchCamera(e.target.value);
    });

    // Seletor de qualidade
    qualitySwitch.value = '1080p';
    qualitySwitch.addEventListener('change', async (e) => {
        await changeQuality(e.target.value);
    });
    
    // Chat
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendChatMessage();
    });
    
    console.log('🔧 Interface configurada');
}

async function getLocalStream() {
    try {
        updateConnectionStatus('connecting', 'Acessando câmera...');
        
        const quality = videoQualities[qualitySwitch.value] || videoQualities['720p'];
        
        const constraints = {
            video: {
                facingMode: cameraOption,
                width: { ideal: quality.width },
                height: { ideal: quality.height },
                frameRate: { ideal: quality.frameRate }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000
            }
        };
        
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        localVideo.srcObject = localStream;
        
        // Esconde placeholder e mostra vídeo
        videoPlaceholder.style.display = 'none';
        localVideo.style.display = 'block';
        
        console.log('📹 Stream local capturado:', {
            video: localStream.getVideoTracks()[0]?.getSettings(),
            audio: localStream.getAudioTracks()[0]?.getSettings()
        });
        
        updateConnectionStatus('connected', 'Câmera ativa');
        
    } catch (error) {
        console.error('❌ Erro ao capturar mídia:', error);
        updateConnectionStatus('disconnected', 'Erro na câmera');
        
        let errorMsg = 'Erro ao acessar câmera/microfone.';
        if (error.name === 'NotAllowedError') {
            errorMsg = 'Permissão negada. Permita acesso à câmera e microfone.';
        } else if (error.name === 'NotFoundError') {
            errorMsg = 'Câmera ou microfone não encontrados.';
        }
        
        alert(errorMsg);
        throw error;
    }
}

async function connectToServer() {
    return new Promise((resolve, reject) => {
        updateConnectionStatus('connecting', 'Conectando ao servidor...');
        
        console.log('🔌 Tentando conectar WebSocket:', wsUrl);
        ws = new WebSocket(wsUrl);
        
        let fallbackAttempted = false;
        
        ws.onopen = () => {
            console.log('🔌 WebSocket conectado com sucesso');
            updateConnectionStatus('connected', 'Conectado ao servidor');
            reconnectAttempts = 0;
            resolve();
        };
        
        ws.onmessage = async (event) => {
            try {
                console.log('📨 Mensagem WebSocket recebida:', event.data);
                const data = JSON.parse(event.data);
                await handleServerMessage(data);
            } catch (error) {
                console.error('❌ Erro ao processar mensagem:', error);
            }
        };
        
        ws.onerror = (error) => {
            console.error('❌ Erro WebSocket:', error);
            
            // Tenta fallback para HTTP se HTTPS falhar
            if (!fallbackAttempted && wsUrl.startsWith('wss://')) {
                fallbackAttempted = true;
                console.log('🔄 Tentando fallback para HTTP:', wsUrlFallback);
                
                ws = new WebSocket(wsUrlFallback);
                
                ws.onopen = () => {
                    console.log('🔌 WebSocket conectado via fallback HTTP');
                    updateConnectionStatus('connected', 'Conectado ao servidor (HTTP)');
                    reconnectAttempts = 0;
                    resolve();
                };
                
                ws.onerror = (fallbackError) => {
                    console.error('❌ Erro WebSocket fallback:', fallbackError);
                    updateConnectionStatus('disconnected', 'Erro na conexão');
                    reject(fallbackError);
                };
                
                ws.onclose = (event) => {
                    console.log('🔌 WebSocket fallback desconectado:', event.code, event.reason);
                    handleWebSocketClose(event);
                };
                
                ws.onmessage = async (event) => {
                    try {
                        console.log('📨 Mensagem WebSocket recebida (fallback):', event.data);
                        const data = JSON.parse(event.data);
                        await handleServerMessage(data);
                    } catch (error) {
                        console.error('❌ Erro ao processar mensagem:', error);
                    }
                };
            } else {
                updateConnectionStatus('disconnected', 'Erro na conexão');
                reject(error);
            }
        };
        
        ws.onclose = (event) => {
            console.log('🔌 WebSocket desconectado:', event.code, event.reason);
            handleWebSocketClose(event);
        };
    });
}

function handleWebSocketClose(event) {
    updateConnectionStatus('disconnected', 'Desconectado');
    isStreaming = false;
    
    // Tentativa de reconexão
    if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        console.log(`🔄 Tentativa de reconexão ${reconnectAttempts}/${maxReconnectAttempts}`);
        setTimeout(() => {
            connectToServer().catch(console.error);
        }, 2000 * reconnectAttempts);
    }
}

async function handleServerMessage(data) {
    console.log('📨 Mensagem recebida:', data.type);
    
    switch (data.type) {
        case 'stream-data':
            await handleStreamData(data.streamData, data.viewerId);
            break;
        case 'chat':
            handleChatMessage(data);
            break;
        case 'viewer-joined':
            handleViewerJoined(data);
            break;
        case 'viewer-left':
            handleViewerLeft(data);
            break;
        case 'viewer-count':
            viewerCount.textContent = data.count || 0;
            break;
        case 'error':
            console.error('❌ Erro do servidor:', data.message);
            alert(data.message);
            break;
        default:
            console.log('❓ Mensagem não tratada:', data.type);
    }
}

async function handleStreamData(streamData, viewerId) {
    if (!streamData || !viewerId) return;
    
    const streamType = streamData.type;
    console.log(`📡 Recebido ${streamType} de espectador ${viewerId}`);
    
    try {
        let peerConnection = peerConnections.get(viewerId);
        
        if (!peerConnection) {
            peerConnection = await createPeerConnection(viewerId);
            peerConnections.set(viewerId, peerConnection);
        }
        
        switch (streamType) {
            case 'answer':
                await peerConnection.setRemoteDescription(new RTCSessionDescription(streamData.answer));
                console.log(`✅ Resposta processada para ${viewerId}`);
                break;
            case 'ice-candidate':
                await peerConnection.addIceCandidate(new RTCIceCandidate(streamData.candidate));
                console.log(`🧊 ICE candidate adicionado para ${viewerId}`);
                break;
        }
    } catch (error) {
        console.error(`❌ Erro ao processar ${streamType} de ${viewerId}:`, error);
    }
}

async function createPeerConnection(viewerId) {
    const peerConnection = new RTCPeerConnection(rtcConfig);
    
    // Adiciona tracks locais
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }
    
    // Eventos WebRTC
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'stream-data',
                liveId: liveId,
                viewerId: viewerId,
                streamData: {
                    type: 'ice-candidate',
                    candidate: event.candidate
                }
            }));
        }
    };
    
    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        console.log(`🔗 Estado da conexão WebRTC com ${viewerId}: ${state}`);
        
        switch (state) {
            case 'connected':
                updateViewerCount();
                break;
            case 'disconnected':
            case 'failed':
            case 'closed':
                console.log(`👋 Espectador ${viewerId} desconectou`);
                peerConnections.delete(viewerId);
                updateViewerCount();
                break;
        }
    };
    
    peerConnection.onicegatheringstatechange = () => {
        console.log(`🧊 ICE gathering state para ${viewerId}: ${peerConnection.iceGatheringState}`);
    };
    
    // Cria e envia oferta
    try {
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: false
        });
        
        await peerConnection.setLocalDescription(offer);
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'stream-data',
                liveId: liveId,
                viewerId: viewerId,
                streamData: {
                    type: 'offer',
                    offer: offer
                }
            }));
        }
        
        console.log(`🤝 Oferta criada e enviada para ${viewerId}`);
    } catch (error) {
        console.error(`❌ Erro ao criar oferta para ${viewerId}:`, error);
    }
    
    return peerConnection;
}

async function startStreaming() {
    try {
        console.log('🎬 Iniciando transmissão...');
        console.log('🔍 Estado WebSocket:', ws ? ws.readyState : 'null');
        console.log('🔍 Live ID:', liveId);
        
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket não conectado');
        }
        
        // Notifica servidor
        const message = {
            type: 'streamer-start',
            liveId: liveId
        };
        
        console.log('📤 Enviando mensagem streamer-start:', message);
        ws.send(JSON.stringify(message));
        
        isStreaming = true;
        startTime = Date.now();
        
        // Inicia contador de duração
        durationInterval = setInterval(updateDuration, 1000);
        
        updateConnectionStatus('connected', 'Transmitindo');
        console.log('✅ Transmissão iniciada');
        
    } catch (error) {
        console.error('❌ Erro ao iniciar transmissão:', error);
        updateConnectionStatus('disconnected', 'Erro na transmissão');
        throw error;
    }
}

async function switchCamera(facingMode) {
    try {
        console.log('🔄 Alternando câmera para:', facingMode);
        updateConnectionStatus('connecting', 'Alternando câmera...');
        
        const quality = videoQualities[qualitySwitch.value] || videoQualities['720p'];
        
        const newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: facingMode,
                width: { ideal: quality.width },
                height: { ideal: quality.height },
                frameRate: { ideal: quality.frameRate }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        
        // Substitui tracks em todas as conexões
        const newVideoTrack = newStream.getVideoTracks()[0];
        const newAudioTrack = newStream.getAudioTracks()[0];
        
        for (const [viewerId, peerConnection] of peerConnections) {
            const videoSender = peerConnection.getSenders().find(s => 
                s.track && s.track.kind === 'video'
            );
            const audioSender = peerConnection.getSenders().find(s => 
                s.track && s.track.kind === 'audio'
            );
            
            if (videoSender && newVideoTrack) {
                await videoSender.replaceTrack(newVideoTrack);
            }
            if (audioSender && newAudioTrack) {
                await audioSender.replaceTrack(newAudioTrack);
            }
        }
        
        // Para tracks antigos
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        
        // Atualiza stream local
        localStream = newStream;
        localVideo.srcObject = localStream;
        
        updateConnectionStatus('connected', 'Transmitindo');
        console.log('✅ Câmera alternada com sucesso');
        
    } catch (error) {
        console.error('❌ Erro ao alternar câmera:', error);
        updateConnectionStatus('disconnected', 'Erro na câmera');
    }
}

async function changeQuality(quality) {
    try {
        console.log('🎯 Alterando qualidade para:', quality);
        await switchCamera(cameraSwitch.value);
        document.getElementById('quality').textContent = quality.toUpperCase();
    } catch (error) {
        console.error('❌ Erro ao alterar qualidade:', error);
    }
}

function toggleMute() {
    if (!localStream) return;
    
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        const button = event.target;
        button.textContent = audioTrack.enabled ? '🔊 Áudio' : '🔇 Mudo';
    }
}

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message || !ws || ws.readyState !== WebSocket.OPEN) return;
    
    ws.send(JSON.stringify({
        type: 'chat',
        liveId: liveId,
        name: 'Streamer',
        message: message,
        timestamp: new Date().toISOString()
    }));
    
    chatInput.value = '';
}

function handleChatMessage(data) {
    const li = document.createElement('li');
    li.textContent = `${data.name}: ${data.message}`;
    
    if (data.name === 'Streamer') {
        li.style.fontWeight = 'bold';
        li.style.color = '#ff6b6b';
    }
    
    chatMessages.appendChild(li);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    // Limita mensagens
    if (chatMessages.children.length > 100) {
        chatMessages.removeChild(chatMessages.firstChild);
    }
}

async function handleViewerJoined(data) {
    console.log('👥 Novo espectador:', data.viewerId);

    const viewerId = data.viewerId;
    if (!viewerId) return;

    // Cria conexão WebRTC para o novo espectador
    if (!peerConnections.has(viewerId)) {
        try {
            const pc = await createPeerConnection(viewerId);
            peerConnections.set(viewerId, pc);
        } catch (error) {
            console.error(`❌ Erro ao criar conexão para ${viewerId}:`, error);
        }
    }

    updateViewerCount();
}

function handleViewerLeft(data) {
    console.log('👋 Espectador saiu:', data.viewerId);

    const viewerId = data.viewerId;
    const pc = peerConnections.get(viewerId);
    if (pc) {
        pc.close();
        peerConnections.delete(viewerId);
    }

    updateViewerCount();
}

function updateViewerCount() {
    const count = peerConnections.size;
    viewerCount.textContent = count;
    
    if (count > 0) {
        updateConnectionStatus('connected', `Transmitindo para ${count} espectador${count > 1 ? 'es' : ''}`);
    } else {
        updateConnectionStatus('connected', 'Aguardando espectadores...');
    }
}

function updateDuration() {
    if (!startTime) return;
    
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    
    duration.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function updateConnectionStatus(status, text) {
    connectionStatus.className = `connection-status ${status}`;
    connectionStatus.textContent = text;
}

// Cleanup ao sair
window.addEventListener('beforeunload', () => {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    for (const [viewerId, peerConnection] of peerConnections) {
        peerConnection.close();
    }
    
    if (ws) {
        ws.close();
    }
    
    if (durationInterval) {
        clearInterval(durationInterval);
    }
});

// Detecta mudanças de visibilidade
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('📱 Página oculta');
    } else {
        console.log('📱 Página visível');
    }
});

console.log('✅ Script do streamer carregado');

