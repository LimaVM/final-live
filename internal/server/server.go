package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"motostream/internal/stream"
	"motostream/internal/websocket"
)

// Server representa o servidor HTTP principal
type Server struct {
	streamManager *stream.Manager
	wsHandler     *websocket.Handler
}

// New cria uma nova instância do servidor
func New() *Server {
	streamManager := stream.NewManager()
	wsHandler := websocket.NewHandler(streamManager)

	return &Server{
		streamManager: streamManager,
		wsHandler:     wsHandler,
	}
}

// Handler retorna o handler HTTP principal
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// WebSocket endpoint
	mux.HandleFunc("/ws", s.handleWebSocket)

	// API endpoints
	mux.HandleFunc("/api/stats", s.handleStats)

	// Páginas principais
	mux.HandleFunc("/", s.handleIndex)
	mux.HandleFunc("/live/", s.handleLive)

	// Arquivos estáticos
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("web/static"))))
	// Segmentos HLS
	mux.Handle("/hls/", http.StripPrefix("/hls/", http.FileServer(http.Dir("web/hls"))))

	// Middleware de logging
	return loggingMiddleware(corsMiddleware(mux))
}

// handleWebSocket gerencia conexões WebSocket
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	clientIP := getClientIP(r)
	userAgent := r.Header.Get("User-Agent")

	log.Printf("🔌 NOVA CONEXÃO WEBSOCKET")
	log.Printf("   IP: %s", clientIP)
	log.Printf("   User-Agent: %s", truncateString(userAgent, 100))

	s.wsHandler.HandleConnection(w, r)
}

// handleStats retorna estatísticas do servidor
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	stats := s.streamManager.GetStats()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(stats)
}

// handleIndex serve a página inicial
func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}

	clientIP := getClientIP(r)
	log.Printf("🏠 Acesso à página inicial de %s", clientIP)

	http.ServeFile(w, r, "web/static/index.html")
}

// handleLive serve páginas de live
func (s *Server) handleLive(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/live/")
	if path == "" {
		http.NotFound(w, r)
		return
	}

	// Extrai o ID da live
	liveID := strings.Split(path, "/")[0]
	if liveID == "" {
		http.NotFound(w, r)
		return
	}

	// Evita servir arquivos JavaScript como HTML
	if strings.HasSuffix(liveID, ".js") || strings.HasSuffix(liveID, ".css") {
		http.NotFound(w, r)
		return
	}

	clientIP := getClientIP(r)

	// Verifica se é streamer ou espectador
	if r.URL.Query().Get("camera") != "" {
		log.Printf("🎥 ACESSO PÁGINA STREAMER")
		log.Printf("   Live ID: %s", liveID)
		log.Printf("   IP: %s", clientIP)
		log.Printf("   Camera: %s", r.URL.Query().Get("camera"))

		http.ServeFile(w, r, "web/static/streamer.html")
	} else {
		log.Printf("👥 ACESSO PÁGINA ESPECTADOR")
		log.Printf("   Live ID: %s", liveID)
		log.Printf("   IP: %s", clientIP)

		http.ServeFile(w, r, "web/static/live.html")
	}
}

// loggingMiddleware adiciona logging às requisições HTTP
func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Não faz wrapping em requisições WebSocket para evitar quebra do upgrade
		if r.URL.Path == "/ws" {
			next.ServeHTTP(w, r)
			return
		}

		start := time.Now()

		// Wrapper para capturar status code
		wrapped := &responseWriter{ResponseWriter: w, statusCode: 200}

		next.ServeHTTP(wrapped, r)

		duration := time.Since(start)
		clientIP := getClientIP(r)

		// Log apenas para requisições não estáticas
		if !strings.HasPrefix(r.URL.Path, "/static/") && r.URL.Path != "/favicon.ico" {
			log.Printf("📡 %s %s %d %v %s", r.Method, r.URL.Path, wrapped.statusCode, duration, clientIP)
		}
	})
}

// corsMiddleware adiciona headers CORS
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// responseWriter wrapper para capturar status code
type responseWriter struct {
	http.ResponseWriter
	statusCode int
}

func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

// Hijack implements the http.Hijacker interface by delegating to the underlying ResponseWriter.
func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := rw.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not implement http.Hijacker")
	}
	return h.Hijack()
}

// getClientIP extrai o IP real do cliente
func getClientIP(r *http.Request) string {
	// Verifica headers de proxy
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.Split(ip, ",")[0]
	}
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}

	// IP direto
	return strings.Split(r.RemoteAddr, ":")[0]
}

// truncateString trunca string se for muito longa
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
