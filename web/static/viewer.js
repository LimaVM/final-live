console.log('👥 DevLima MotoStream Viewer - HLS player');

// Elementos da interface
const remoteVideo = document.getElementById('remoteVideo');
const connectionStatus = document.getElementById('connection-status');
const videoPlaceholder = document.getElementById('video-placeholder');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const viewerCount = document.getElementById('viewer-count');
const totalViewers = document.getElementById('total-viewers');
const duration = document.getElementById('duration');

// Configuração
const liveId = window.location.pathname.split('/')[2];
const viewerId = 'viewer_' + Math.random().toString(36).substr(2, 9);
let viewerName = '';
let ws = null;
let startTime = null;
let durationInterval = null;

document.addEventListener('DOMContentLoaded', () => {
    while (!viewerName) {
        viewerName = prompt('Digite seu nickname:')?.trim() || '';
    }
    setupPlayer();
    connectWebSocket();
    setupChat();
});

function setupPlayer() {
    const src = `/hls/${liveId}.m3u8`;
    if (Hls.isSupported()) {
        const hls = new Hls({lowLatencyMode: true});
        hls.loadSource(src);
        hls.attachMedia(remoteVideo);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            remoteVideo.play().catch(console.error);
        });
        hls.on(Hls.Events.ERROR, () => {
            updateConnectionStatus('disconnected', 'Erro na transmissão');
        });
    } else if (remoteVideo.canPlayType('application/vnd.apple.mpegurl')) {
        remoteVideo.src = src;
        remoteVideo.addEventListener('loadedmetadata', () => {
            remoteVideo.play().catch(console.error);
        });
    } else {
        showOfflineMessage('Seu navegador não suporta HLS');
    }

    remoteVideo.addEventListener('playing', () => {
        updateConnectionStatus('connected', 'Assistindo transmissão');
        if (!startTime) {
            startTime = Date.now();
            durationInterval = setInterval(updateDuration, 1000);
        }
    });

    remoteVideo.addEventListener('waiting', () => {
        updateConnectionStatus('connecting', 'Carregando...');
    });

    remoteVideo.addEventListener('ended', () => {
        updateConnectionStatus('disconnected', 'Transmissão encerrada');
    });
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    ws.onopen = () => {
        updateConnectionStatus('connected', 'Conectado ao servidor');
        ws.send(JSON.stringify({
            type: 'join',
            liveId: liveId,
            viewerId: viewerId,
            name: viewerName
        }));
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        switch (data.type) {
            case 'viewer-count':
                viewerCount.textContent = data.count;
                totalViewers.textContent = `${data.count} pessoas assistindo`;
                break;
            case 'chat':
                addChatMessage(data.name, data.message);
                speakMessage(data.name, data.message);
                break;
            default:
                break;
        }
    };

    ws.onclose = () => {
        updateConnectionStatus('disconnected', 'Desconectado do servidor');
    };
}

function setupChat() {
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = chatInput.value.trim();
        if (!message || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            type: 'chat',
            liveId: liveId,
            name: viewerName,
            message: message
        }));
        chatInput.value = '';
    });
}

function addChatMessage(name, message) {
    const li = document.createElement('li');
    li.textContent = `${name}: ${message}`;
    chatMessages.appendChild(li);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function speakMessage(name, message) {
    const utterance = new SpeechSynthesisUtterance(`${name} disse ${message}`);
    const voices = speechSynthesis.getVoices();
    const voice = voices.find(v => v.lang.startsWith('pt') && /male|homem/i.test(v.name)) || voices.find(v => v.lang.startsWith('pt'));
    if (voice) utterance.voice = voice;
    speechSynthesis.speak(utterance);
}

function updateConnectionStatus(status, text) {
    connectionStatus.className = `connection-status ${status}`;
    connectionStatus.textContent = text;
}

function showOfflineMessage(text) {
    videoPlaceholder.innerHTML = `<div class="icon">📺</div><div>${text}</div>`;
    videoPlaceholder.style.display = 'block';
}

function updateDuration() {
    const diff = Math.floor((Date.now() - startTime) / 1000);
    const minutes = String(Math.floor(diff / 60)).padStart(2, '0');
    const seconds = String(diff % 60).padStart(2, '0');
    duration.textContent = `${minutes}:${seconds}`;
}
