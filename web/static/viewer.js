// DevLima MotoStream - Script do Espectador (Go Backend)
// Implementação WebRTC otimizada para resolver problemas de tela preta

console.log('👥 DevLima MotoStream Viewer - Iniciando...');

// Elementos da interface
const remoteVideo = document.getElementById('remoteVideo');
const remoteWrapper = document.getElementById('remote-wrapper');
const videoPlaceholder = document.getElementById('video-placeholder');
const connectionStatus = document.getElementById('connection-status');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');
const qualityIndicator = document.getElementById('quality-indicator');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const viewerCount = document.getElementById('viewer-count');
const totalViewers = document.getElementById('total-viewers');
const duration = document.getElementById('duration');

// Configuração
const liveId = window.location.pathname.split('/')[2];
const viewerId = 'viewer_' + Math.random().toString(36).substr(2, 9);

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
let peerConnection = null;
let isConnected = false;
let startTime = null;
let durationInterval = null;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;

// Inicialização
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('🚀 Inicializando espectador...');
        await initializeViewer();
    } catch (error) {
        console.error('❌ Erro ao inicializar:', error);
        updateConnectionStatus('disconnected', 'Erro fatal');
        showOfflineMessage('Erro ao conectar. Recarregue a página.');
    }
});

async function initializeViewer() {
    // Configura interface
    setupInterface();
    
    // Conecta ao servidor
    await connectToServer();
    
    // Entra na live
    await joinLive();
    
    console.log('✅ Espectador inicializado com sucesso');
}

function setupInterface() {
    // Controle de volume
    volumeSlider.addEventListener('input', (e) => {
        const volume = e.target.value / 100;
        remoteVideo.volume = volume;
        volumeValue.textContent = `${e.target.value}%`;
    });
    
    // Chat
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        sendChatMessage();
    });
    
    // Eventos do vídeo
    remoteVideo.addEventListener('loadedmetadata', () => {
        console.log('📺 Metadados do vídeo carregados');
        updateQualityIndicator();
    });
    
    remoteVideo.addEventListener('canplay', () => {
        console.log('📺 Vídeo pronto para reprodução');
    });
    
    remoteVideo.addEventListener('playing', () => {
        console.log('📺 Vídeo reproduzindo');
        updateConnectionStatus('connected', 'Assistindo transmissão');
        hideVideoPlaceholder();
        
        if (!startTime) {
            startTime = Date.now();
            durationInterval = setInterval(updateDuration, 1000);
        }
    });
    
    remoteVideo.addEventListener('waiting', () => {
        console.log('📺 Vídeo aguardando dados');
        updateConnectionStatus('connecting', 'Carregando...');
    });
    
    remoteVideo.addEventListener('error', (e) => {
        console.error('❌ Erro no vídeo:', e);
        updateConnectionStatus('disconnected', 'Erro no vídeo');
        showVideoPlaceholder();
    });
    
    remoteVideo.addEventListener('ended', () => {
        console.log('📺 Vídeo terminou');
        showOfflineMessage('Transmissão encerrada');
    });
    
    console.log('🔧 Interface configurada');
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
    isConnected = false;
    
    // Mostra mensagem offline
    showOfflineMessage('Conexão perdida');
    
    // Tentativa de reconexão
    if (reconnectAttempts < maxReconnectAttempts) {
        reconnectAttempts++;
        console.log(`🔄 Tentativa de reconexão ${reconnectAttempts}/${maxReconnectAttempts}`);
        setTimeout(() => {
            connectToServer().then(() => joinLive()).catch(console.error);
        }, 2000 * reconnectAttempts);
    }
}

async function handleServerMessage(data) {
    console.log('📨 Mensagem recebida:', data.type);
    
    switch (data.type) {
        case 'stream-started':
            updateConnectionStatus('connecting', 'Transmissão iniciada');
            break;
        case 'stream-ended':
            updateConnectionStatus('disconnected', 'Transmissão encerrada');
            showOfflineMessage('Transmissão encerrada pelo streamer');
            break;
        case 'stream-data':
            await handleStreamData(data.streamData);
            break;
        case 'chat':
            handleChatMessage(data);
            break;
        case 'viewer-count':
            updateViewerCount(data.count);
            break;
        case 'error':
            console.error('❌ Erro do servidor:', data.message);
            showOfflineMessage(data.message);
            break;
        default:
            console.log('❓ Mensagem não tratada:', data.type);
    }
}

async function handleStreamData(streamData) {
    if (!streamData) return;
    
    const streamType = streamData.type;
    console.log(`📡 Recebido ${streamType} do servidor`);
    
    try {
        // Cria conexão WebRTC se não existir
        if (!peerConnection) {
            peerConnection = await createPeerConnection();
        }
        
        switch (streamType) {
            case 'offer':
                await handleOffer(streamData.offer);
                break;
            case 'ice-candidate':
                await handleIceCandidate(streamData.candidate);
                break;
        }
    } catch (error) {
        console.error(`❌ Erro ao processar ${streamType}:`, error);
    }
}

async function createPeerConnection() {
    const pc = new RTCPeerConnection(rtcConfig);
    
    // Eventos WebRTC
    pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'stream-data',
                liveId: liveId,
                streamData: {
                    type: 'ice-candidate',
                    candidate: event.candidate
                }
            }));
        }
    };
    
    pc.ontrack = (event) => {
        console.log('📺 Stream recebido do streamer');
        const [remoteStream] = event.streams;
        
        if (remoteStream) {
            remoteVideo.srcObject = remoteStream;
            hideVideoPlaceholder();
            updateConnectionStatus('connected', 'Recebendo transmissão');
            isConnected = true;
            
            // Força reprodução
            remoteVideo.play().catch(error => {
                console.log('⚠️  Reprodução automática bloqueada:', error);
                // Mostra botão de play se necessário
                showPlayButton();
            });
        }
    };
    
    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log('🔗 Estado da conexão WebRTC:', state);
        
        switch (state) {
            case 'connected':
                updateConnectionStatus('connected', 'Assistindo transmissão');
                isConnected = true;
                break;
            case 'disconnected':
                updateConnectionStatus('connecting', 'Reconectando...');
                isConnected = false;
                break;
            case 'failed':
                updateConnectionStatus('disconnected', 'Falha na conexão');
                isConnected = false;
                showOfflineMessage('Falha na conexão WebRTC');
                break;
            case 'closed':
                updateConnectionStatus('disconnected', 'Conexão fechada');
                isConnected = false;
                break;
            case 'connecting':
                updateConnectionStatus('connecting', 'Conectando ao stream...');
                break;
        }
    };
    
    pc.onicegatheringstatechange = () => {
        console.log('🧊 ICE gathering state:', pc.iceGatheringState);
    };
    
    pc.oniceconnectionstatechange = () => {
        console.log('🧊 ICE connection state:', pc.iceConnectionState);
    };
    
    console.log('✅ Conexão WebRTC criada');
    return pc;
}

async function handleOffer(offer) {
    try {
        console.log('🤝 Processando oferta do streamer');
        
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        // Envia resposta para o servidor
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'stream-data',
                liveId: liveId,
                streamData: {
                    type: 'answer',
                    answer: answer
                }
            }));
        }
        
        console.log('✅ Resposta enviada para o servidor');
        
    } catch (error) {
        console.error('❌ Erro ao processar oferta:', error);
        showOfflineMessage('Erro ao conectar com o streamer');
    }
}

async function handleIceCandidate(candidate) {
    try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log('🧊 ICE candidate adicionado');
    } catch (error) {
        console.error('❌ Erro ao adicionar ICE candidate:', error);
    }
}

async function joinLive() {
    try {
        console.log('👥 Entrando na live...');
        console.log('🔍 Estado WebSocket:', ws ? ws.readyState : 'null');
        console.log('🔍 Live ID:', liveId);
        console.log('🔍 Viewer ID:', viewerId);
        
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket não conectado');
        }
        
        // Envia mensagem para entrar na live
        const message = {
            type: 'join',
            liveId: liveId,
            viewerId: viewerId
        };
        
        console.log('📤 Enviando mensagem join:', message);
        ws.send(JSON.stringify(message));
        
        updateConnectionStatus('connecting', 'Aguardando transmissão...');
        console.log('✅ Solicitação para entrar na live enviada');
        
    } catch (error) {
        console.error('❌ Erro ao entrar na live:', error);
        updateConnectionStatus('disconnected', 'Erro ao entrar na live');
        showOfflineMessage('Erro ao entrar na live');
    }
}

function sendChatMessage() {
    const message = chatInput.value.trim();
    if (!message || !ws || ws.readyState !== WebSocket.OPEN) return;
    
    ws.send(JSON.stringify({
        type: 'chat',
        liveId: liveId,
        name: 'Espectador',
        message: message,
        timestamp: new Date().toISOString()
    }));
    
    chatInput.value = '';
}

function handleChatMessage(data) {
    const li = document.createElement('li');
    li.textContent = `${data.name}: ${data.message}`;
    
    // Destaca mensagens do streamer
    if (data.name === 'Streamer') {
        li.classList.add('streamer');
    }
    
    chatMessages.appendChild(li);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    // Limita mensagens
    if (chatMessages.children.length > 100) {
        chatMessages.removeChild(chatMessages.firstChild);
    }
}

function updateViewerCount(count) {
    viewerCount.textContent = count || 0;
    totalViewers.textContent = `${count || 0} pessoa${count !== 1 ? 's' : ''} assistindo`;
}

function updateDuration() {
    if (!startTime) return;
    
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    
    duration.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function updateQualityIndicator() {
    if (!remoteVideo.videoWidth || !remoteVideo.videoHeight) return;
    
    const width = remoteVideo.videoWidth;
    const height = remoteVideo.videoHeight;
    
    let quality = 'SD';
    if (height >= 1080) quality = 'FHD';
    else if (height >= 720) quality = 'HD';
    else if (height >= 480) quality = 'SD';
    
    qualityIndicator.textContent = quality;
}

function showVideoPlaceholder() {
    videoPlaceholder.style.display = 'flex';
    remoteVideo.style.display = 'none';
}

function hideVideoPlaceholder() {
    videoPlaceholder.style.display = 'none';
    remoteVideo.style.display = 'block';
}

function showOfflineMessage(message) {
    videoPlaceholder.innerHTML = `
        <div class="offline-message">
            <div class="icon">📺</div>
            <h3>Transmissão Offline</h3>
            <p>${message}</p>
        </div>
    `;
    showVideoPlaceholder();
    
    // Para o vídeo se estiver reproduzindo
    if (remoteVideo.srcObject) {
        remoteVideo.srcObject = null;
    }
    
    // Para contador de duração
    if (durationInterval) {
        clearInterval(durationInterval);
        durationInterval = null;
        startTime = null;
    }
}

function showPlayButton() {
    const playButton = document.createElement('button');
    playButton.textContent = '▶️ Reproduzir';
    playButton.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        padding: 1rem 2rem;
        font-size: 1.2rem;
        background: #4ecdc4;
        color: white;
        border: none;
        border-radius: 10px;
        cursor: pointer;
        z-index: 10;
    `;
    
    playButton.onclick = () => {
        remoteVideo.play();
        playButton.remove();
    };
    
    remoteWrapper.appendChild(playButton);
}

function toggleFullscreen() {
    if (!document.fullscreenElement) {
        remoteWrapper.requestFullscreen().catch(err => {
            console.log('❌ Erro ao entrar em tela cheia:', err);
        });
    } else {
        document.exitFullscreen();
    }
}

function updateConnectionStatus(status, text) {
    connectionStatus.className = `connection-status ${status}`;
    connectionStatus.textContent = text;
}

// Cleanup ao sair
window.addEventListener('beforeunload', () => {
    if (peerConnection) {
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
        // Tenta reconectar se necessário
        if (!isConnected && ws && ws.readyState !== WebSocket.OPEN) {
            connectToServer().then(() => joinLive()).catch(console.error);
        }
    }
});

console.log('✅ Script do espectador carregado');

