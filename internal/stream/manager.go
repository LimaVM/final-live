package stream

import (
	"fmt"
	"sync"
	"time"
)

// Connection interface para conexões WebSocket
type Connection interface{}

// Message representa uma mensagem para envio
type Message struct {
	Type       string      `json:"type"`
	LiveID     string      `json:"liveId,omitempty"`
	ViewerID   string      `json:"viewerId,omitempty"`
	StreamData interface{} `json:"streamData,omitempty"`
	Name       string      `json:"name,omitempty"`
	Message    string      `json:"message,omitempty"`
	Timestamp  string      `json:"timestamp,omitempty"`
	Count      int         `json:"count,omitempty"`
}

// Session representa uma sessão de streaming
type Session struct {
	LiveID            string
	Streamer          Connection
	Viewers           map[Connection]bool
	IsActive          bool
	CreatedAt         time.Time
	LastActivity      time.Time
	TotalViewersCount int
	PeakViewers       int
	mutex             sync.RWMutex
}

// Manager gerencia sessões de streaming
type Manager struct {
	sessions map[string]*Session
	mutex    sync.RWMutex
}

// Stats representa estatísticas do servidor
type Stats struct {
	ActiveSessions   int                    `json:"activeSessions"`
	TotalStreamers   int                    `json:"totalStreamers"`
	TotalViewers     int                    `json:"totalViewers"`
	SessionDetails   map[string]SessionInfo `json:"sessionDetails"`
	Uptime           string                 `json:"uptime"`
	TotalConnections int                    `json:"totalConnections"`
}

// SessionInfo representa informações de uma sessão
type SessionInfo struct {
	LiveID       string    `json:"liveId"`
	IsActive     bool      `json:"isActive"`
	ViewersCount int       `json:"viewersCount"`
	PeakViewers  int       `json:"peakViewers"`
	TotalViewers int       `json:"totalViewers"`
	CreatedAt    time.Time `json:"createdAt"`
	LastActivity time.Time `json:"lastActivity"`
	Duration     string    `json:"duration"`
}

var startTime = time.Now()

// NewManager cria um novo gerenciador de streams
func NewManager() *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
	}
}

// SetStreamer define o streamer para uma live
func (m *Manager) SetStreamer(liveID string, conn Connection) error {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	session := m.getOrCreateSession(liveID)

	// Verifica se já há um streamer ativo
	if session.Streamer != nil && session.IsActive {
		return fmt.Errorf("já existe um streamer ativo nesta live")
	}

	session.Streamer = conn
	session.IsActive = true
	session.LastActivity = time.Now()

	return nil
}

// RemoveStreamer remove o streamer de uma live
func (m *Manager) RemoveStreamer(liveID string) {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	if session, exists := m.sessions[liveID]; exists {
		session.mutex.Lock()
		session.Streamer = nil
		session.IsActive = false
		session.mutex.Unlock()

		// Remove sessão se não há mais viewers
		if len(session.Viewers) == 0 {
			delete(m.sessions, liveID)
		}
	}
}

// AddViewer adiciona um espectador à live
func (m *Manager) AddViewer(liveID string, conn Connection) {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	session := m.getOrCreateSession(liveID)

	session.mutex.Lock()
	session.Viewers[conn] = true
	session.TotalViewersCount++
	session.LastActivity = time.Now()

	// Atualiza pico de espectadores
	currentViewers := len(session.Viewers)
	if currentViewers > session.PeakViewers {
		session.PeakViewers = currentViewers
	}
	session.mutex.Unlock()
}

// RemoveViewer remove um espectador da live
func (m *Manager) RemoveViewer(liveID string, conn Connection) {
	m.mutex.Lock()
	defer m.mutex.Unlock()

	if session, exists := m.sessions[liveID]; exists {
		session.mutex.Lock()
		delete(session.Viewers, conn)
		session.mutex.Unlock()

		// Remove sessão se não há mais streamer nem viewers
		if session.Streamer == nil && len(session.Viewers) == 0 {
			delete(m.sessions, liveID)
		}
	}
}

// GetStreamer retorna o streamer de uma live
func (m *Manager) GetStreamer(liveID string) Connection {
	m.mutex.RLock()
	defer m.mutex.RUnlock()

	if session, exists := m.sessions[liveID]; exists {
		session.mutex.RLock()
		defer session.mutex.RUnlock()
		return session.Streamer
	}

	return nil
}

// GetViewers retorna os espectadores de uma live
func (m *Manager) GetViewers(liveID string) []Connection {
	m.mutex.RLock()
	defer m.mutex.RUnlock()

	if session, exists := m.sessions[liveID]; exists {
		session.mutex.RLock()
		defer session.mutex.RUnlock()

		viewers := make([]Connection, 0, len(session.Viewers))
		for viewer := range session.Viewers {
			viewers = append(viewers, viewer)
		}
		return viewers
	}

	return nil
}

// SetStreamData define os dados do stream

// GetStats retorna estatísticas do servidor
func (m *Manager) GetStats() Stats {
	m.mutex.RLock()
	defer m.mutex.RUnlock()

	stats := Stats{
		ActiveSessions:   0,
		TotalStreamers:   0,
		TotalViewers:     0,
		SessionDetails:   make(map[string]SessionInfo),
		Uptime:           time.Since(startTime).String(),
		TotalConnections: 0,
	}

	for liveID, session := range m.sessions {
		session.mutex.RLock()

		viewersCount := len(session.Viewers)
		stats.TotalViewers += viewersCount
		stats.TotalConnections += viewersCount

		if session.IsActive {
			stats.ActiveSessions++
			if session.Streamer != nil {
				stats.TotalStreamers++
				stats.TotalConnections++
			}
		}

		stats.SessionDetails[liveID] = SessionInfo{
			LiveID:       liveID,
			IsActive:     session.IsActive,
			ViewersCount: viewersCount,
			PeakViewers:  session.PeakViewers,
			TotalViewers: session.TotalViewersCount,
			CreatedAt:    session.CreatedAt,
			LastActivity: session.LastActivity,
			Duration:     time.Since(session.CreatedAt).String(),
		}

		session.mutex.RUnlock()
	}

	return stats
}

// getOrCreateSession obtém ou cria uma sessão
func (m *Manager) getOrCreateSession(liveID string) *Session {
	if session, exists := m.sessions[liveID]; exists {
		return session
	}

	session := &Session{
		LiveID:       liveID,
		Viewers:      make(map[Connection]bool),
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
	}

	m.sessions[liveID] = session
	return session
}
