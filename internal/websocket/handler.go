package websocket

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"motostream/internal/stream"
)

// Handler gerencia conexões WebSocket
type Handler struct {
	upgrader      websocket.Upgrader
	streamManager *stream.Manager
	connections   map[*websocket.Conn]*Connection
	mutex         sync.RWMutex
	connCounter   int64
}

// Connection representa uma conexão WebSocket
type Connection struct {
	ID        string
	Conn      *websocket.Conn
	IP        string
	UserAgent string
	LiveID    string
	UserType  string // "streamer" ou "viewer"
	UserID    string
	Connected time.Time
	LastPing  time.Time
	send      chan []byte
	handler   *Handler
}

// Message representa uma mensagem WebSocket
type Message struct {
	Type       string      `json:"type"`
	LiveID     string      `json:"liveId,omitempty"`
	ViewerID   string      `json:"viewerId,omitempty"`
	StreamData interface{} `json:"streamData,omitempty"`
	Name       string      `json:"name,omitempty"`
	Message    string      `json:"message,omitempty"`
	Timestamp  string      `json:"timestamp,omitempty"`
}

// NewHandler cria um novo handler WebSocket
func NewHandler(streamManager *stream.Manager) *Handler {
	return &Handler{
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool {
				return true // Permite todas as origens
			},
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
		},
		streamManager: streamManager,
		connections:   make(map[*websocket.Conn]*Connection),
	}
}

// HandleConnection gerencia uma nova conexão WebSocket
func (h *Handler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	log.Printf("🔌 TENTATIVA DE CONEXÃO WEBSOCKET")
	log.Printf("   Origin: %s", r.Header.Get("Origin"))
	log.Printf("   Host: %s", r.Header.Get("Host"))
	log.Printf("   Upgrade: %s", r.Header.Get("Upgrade"))
	log.Printf("   Connection: %s", r.Header.Get("Connection"))
	log.Printf("   Sec-WebSocket-Key: %s", r.Header.Get("Sec-WebSocket-Key"))
	log.Printf("   Sec-WebSocket-Version: %s", r.Header.Get("Sec-WebSocket-Version"))

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("❌ Erro ao fazer upgrade WebSocket: %v", err)
		log.Printf("   Headers de resposta: %+v", w.Header())
		return
	}

	log.Printf("✅ WebSocket upgrade bem-sucedido")

	h.mutex.Lock()
	h.connCounter++
	connID := fmt.Sprintf("conn_%d", h.connCounter)
	h.mutex.Unlock()

	// Cria conexão
	connection := &Connection{
		ID:        connID,
		Conn:      conn,
		IP:        getClientIP(r),
		UserAgent: r.Header.Get("User-Agent"),
		Connected: time.Now(),
		LastPing:  time.Now(),
		send:      make(chan []byte, 256),
		handler:   h,
	}

	// Registra conexão
	h.mutex.Lock()
	h.connections[conn] = connection
	h.mutex.Unlock()

	log.Printf("🔌 NOVA CONEXÃO WEBSOCKET")
	log.Printf("   ID: %s", connID)
	log.Printf("   IP: %s", connection.IP)
	log.Printf("   Total conexões: %d", len(h.connections))

	// Inicia goroutines para leitura e escrita
	go connection.writePump()
	go connection.readPump()
}

// readPump lê mensagens do WebSocket
func (c *Connection) readPump() {
	defer func() {
		c.handler.unregisterConnection(c)
		c.Conn.Close()
	}()

	// Configura timeouts
	c.Conn.SetReadLimit(512 * 1024) // 512KB
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		c.LastPing = time.Now()
		return nil
	})

	for {
		_, messageBytes, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("❌ Erro WebSocket %s: %v", c.ID, err)
			}
			break
		}

		var msg Message
		if err := json.Unmarshal(messageBytes, &msg); err != nil {
			log.Printf("⚠️  JSON inválido de %s: %v", c.ID, err)
			continue
		}

		log.Printf("📨 Mensagem recebida de %s: %s", c.ID, msg.Type)
		c.handleMessage(&msg)
	}
}

// writePump escreve mensagens para o WebSocket
func (c *Connection) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Printf("❌ Erro ao enviar mensagem para %s: %v", c.ID, err)
				return
			}

		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// handleMessage processa mensagens recebidas
func (c *Connection) handleMessage(msg *Message) {
	switch msg.Type {
	case "join":
		c.handleJoin(msg)
	case "streamer-start":
		c.handleStreamerStart(msg)
	case "stream-data":
		c.handleStreamData(msg)
	case "chat":
		c.handleChat(msg)
	case "ping":
		c.handlePing(msg)
	default:
		log.Printf("❓ Tipo de mensagem desconhecido '%s' de %s", msg.Type, c.ID)
	}
}

// handleJoin processa entrada de espectador
func (c *Connection) handleJoin(msg *Message) {
	c.LiveID = msg.LiveID
	c.UserType = "viewer"
	c.UserID = msg.ViewerID
	if c.UserID == "" {
		c.UserID = c.ID
	}

	log.Printf("👥 ESPECTADOR ENTROU NA LIVE")
	log.Printf("   Live ID: %s", c.LiveID)
	log.Printf("   User ID: %s", c.UserID)
	log.Printf("   IP: %s", c.IP)

	// Registra no gerenciador de streams
	c.handler.streamManager.AddViewer(c.LiveID, c)

	// Notifica streamer sobre novo espectador
	if streamer := c.handler.streamManager.GetStreamer(c.LiveID); streamer != nil {
		if conn, ok := streamer.(*Connection); ok {
			conn.sendMessage(&stream.Message{
				Type:     "viewer-joined",
				LiveID:   c.LiveID,
				ViewerID: c.UserID,
			})
		}
	}

	// Atualiza contagem de espectadores para todos
	c.handler.broadcastViewerCount(c.LiveID)

	// Se há stream ativo, envia para o novo espectador
	if streamData := c.handler.streamManager.GetActiveStream(c.LiveID); streamData != nil {
		c.sendMessage(&stream.Message{
			Type:       "stream-start",
			StreamData: streamData,
		})
		log.Printf("📺 Stream ativo enviado para %s", c.UserID)
	}
}

// handleStreamerStart processa início de transmissão
func (c *Connection) handleStreamerStart(msg *Message) {
	c.LiveID = msg.LiveID
	c.UserType = "streamer"
	c.UserID = fmt.Sprintf("streamer_%s", c.LiveID)

	log.Printf("🎥 STREAMER INICIOU TRANSMISSÃO")
	log.Printf("   Live ID: %s", c.LiveID)
	log.Printf("   IP: %s", c.IP)

	// Registra no gerenciador de streams
	if err := c.handler.streamManager.SetStreamer(c.LiveID, c); err != nil {
		log.Printf("⚠️  Erro ao registrar streamer: %v", err)
		c.sendMessage(&stream.Message{
			Type:    "error",
			Message: "Já existe um streamer ativo nesta live",
		})
		return
	}

	// Notifica espectadores
	viewers := c.handler.streamManager.GetViewers(c.LiveID)
	for _, viewer := range viewers {
		if conn, ok := viewer.(*Connection); ok {
			conn.sendMessage(&stream.Message{
				Type:    "stream-started",
				Message: "Transmissão iniciada",
			})
		}
	}

	// Atualiza contagem de espectadores
	c.handler.broadcastViewerCount(c.LiveID)

	log.Printf("📢 Notificação enviada para %d espectadores", len(viewers))
}

// handleStreamData processa dados de stream
func (c *Connection) handleStreamData(msg *Message) {
	if c.LiveID == "" {
		log.Printf("🚫 Stream data sem live ID de %s", c.ID)
		return
	}

	if c.UserType == "streamer" {
		// Streamer enviando dados para espectadores
		c.handler.streamManager.SetStreamData(c.LiveID, msg.StreamData)

		viewers := c.handler.streamManager.GetViewers(c.LiveID)
		for _, viewer := range viewers {
			if conn, ok := viewer.(*Connection); ok {
				conn.sendMessage(&stream.Message{
					Type:       "stream-data",
					StreamData: msg.StreamData,
				})
			}
		}

		log.Printf("📤 Stream data distribuído para %d espectadores", len(viewers))

	} else if c.UserType == "viewer" {
		// Espectador enviando resposta para streamer
		if streamer := c.handler.streamManager.GetStreamer(c.LiveID); streamer != nil {
			if conn, ok := streamer.(*Connection); ok {
				conn.sendMessage(&stream.Message{
					Type:       "stream-data",
					StreamData: msg.StreamData,
					ViewerID:   c.UserID,
				})
				log.Printf("📤 Resposta de espectador enviada para streamer")
			}
		}
	}
}

// handleChat processa mensagens de chat
func (c *Connection) handleChat(msg *Message) {
	if c.LiveID == "" {
		return
	}

	log.Printf("💬 CHAT [%s] %s: %s", c.LiveID, msg.Name, msg.Message)

	// Envia para todos na live
	chatMsg := &stream.Message{
		Type:      "chat",
		Name:      msg.Name,
		Message:   msg.Message,
		Timestamp: msg.Timestamp,
		LiveID:    c.LiveID,
	}

	// Para o streamer
	if streamer := c.handler.streamManager.GetStreamer(c.LiveID); streamer != nil {
		if conn, ok := streamer.(*Connection); ok {
			conn.sendMessage(chatMsg)
		}
	}

	// Para todos os espectadores
	viewers := c.handler.streamManager.GetViewers(c.LiveID)
	for _, viewer := range viewers {
		if conn, ok := viewer.(*Connection); ok {
			conn.sendMessage(chatMsg)
		}
	}

	log.Printf("   📤 Enviado para %d usuários", len(viewers)+1)
}

// handlePing responde a pings
func (c *Connection) handlePing(msg *Message) {
	c.LastPing = time.Now()
	c.sendMessage(&stream.Message{
		Type:      "pong",
		Timestamp: msg.Timestamp,
		LiveID:    msg.LiveID,
		ViewerID:  msg.ViewerID,
	})
}

// sendMessage envia mensagem para a conexão
func (c *Connection) sendMessage(msg *stream.Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("❌ Erro ao serializar mensagem: %v", err)
		return
	}

	select {
	case c.send <- data:
	default:
		close(c.send)
	}
}

// unregisterConnection remove conexão
func (h *Handler) unregisterConnection(c *Connection) {
	h.mutex.Lock()
	defer h.mutex.Unlock()

	if _, ok := h.connections[c.Conn]; ok {
		delete(h.connections, c.Conn)
		close(c.send)

		// Remove do gerenciador de streams
		if c.LiveID != "" {
			if c.UserType == "streamer" {
				h.streamManager.RemoveStreamer(c.LiveID)

				// Notifica espectadores
				viewers := h.streamManager.GetViewers(c.LiveID)
				for _, viewer := range viewers {
					if conn, ok := viewer.(*Connection); ok {
						conn.sendMessage(&stream.Message{
							Type:    "stream-ended",
							Message: "Transmissão encerrada",
						})
					}
				}

				// Atualiza contagem
				h.broadcastViewerCount(c.LiveID)

				log.Printf("🎥 STREAMER DESCONECTOU")
				log.Printf("   Live ID: %s", c.LiveID)
				log.Printf("   IP: %s", c.IP)
				log.Printf("   📢 Notificação enviada para %d espectadores", len(viewers))

			} else if c.UserType == "viewer" {
				h.streamManager.RemoveViewer(c.LiveID, c)

				// Notifica streamer
				if streamer := h.streamManager.GetStreamer(c.LiveID); streamer != nil {
					if conn, ok := streamer.(*Connection); ok {
						conn.sendMessage(&stream.Message{
							Type:     "viewer-left",
							LiveID:   c.LiveID,
							ViewerID: c.UserID,
						})
					}
				}

				// Atualiza contagem
				h.broadcastViewerCount(c.LiveID)

				log.Printf("👥 ESPECTADOR DESCONECTOU")
				log.Printf("   Live ID: %s", c.LiveID)
				log.Printf("   User ID: %s", c.UserID)
				log.Printf("   IP: %s", c.IP)
			}
		}

		log.Printf("🔌 Conexão %s desconectada (total: %d)", c.ID, len(h.connections))
	}
}

// broadcastViewerCount envia a contagem de espectadores para streamer e viewers
func (h *Handler) broadcastViewerCount(liveID string) {
	viewers := h.streamManager.GetViewers(liveID)
	count := len(viewers)
	msg := &stream.Message{Type: "viewer-count", LiveID: liveID, Count: count}

	// Para o streamer
	if streamer := h.streamManager.GetStreamer(liveID); streamer != nil {
		if conn, ok := streamer.(*Connection); ok {
			conn.sendMessage(msg)
		}
	}

	// Para todos os espectadores
	for _, viewer := range viewers {
		if conn, ok := viewer.(*Connection); ok {
			conn.sendMessage(msg)
		}
	}
}

// getClientIP extrai IP do cliente
func getClientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.Split(ip, ",")[0]
	}
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	return strings.Split(r.RemoteAddr, ":")[0]
}
