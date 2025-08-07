package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"motostream/internal/server"
)

const (
	defaultHTTPPort  = "80"
	defaultHTTPSPort = "443"
	defaultDevPort   = "8080"
)

func main() {
	// Flags de linha de comando
	var (
		httpPort  = flag.String("http-port", getEnv("HTTP_PORT", defaultHTTPPort), "Porta HTTP")
		httpsPort = flag.String("https-port", getEnv("HTTPS_PORT", defaultHTTPSPort), "Porta HTTPS")
		devMode   = flag.Bool("dev", false, "Modo de desenvolvimento (porta 8080)")
		certFile  = flag.String("cert", getEnv("SSL_CERT", "/etc/letsencrypt/live/devlimassh.shop/fullchain.pem"), "Arquivo de certificado SSL")
		keyFile   = flag.String("key", getEnv("SSL_KEY", "/etc/letsencrypt/live/devlimassh.shop/privkey.pem"), "Arquivo de chave privada SSL")
	)
	flag.Parse()

	// Configuração de logging
	log.SetFlags(log.LstdFlags | log.Lshortfile)

	fmt.Println("🚀 DEVLIMA MOTOSTREAM - SERVIDOR GO INICIANDO...")
	fmt.Println(strings.Repeat("=", 80))
	fmt.Printf("📅 Data/Hora: %s\n", time.Now().Format("02/01/2006 15:04:05"))
	fmt.Printf("🔧 Modo: %s\n", func() string {
		if *devMode {
			return "Desenvolvimento"
		}
		return "Produção"
	}())
	fmt.Println(strings.Repeat("=", 80))

	// Cria o servidor
	srv := server.New()

	// Modo desenvolvimento
	if *devMode {
		fmt.Printf("🌐 Servidor de desenvolvimento rodando na porta %s\n", defaultDevPort)
		fmt.Printf("🔗 Acesso: http://localhost:%s\n", defaultDevPort)

		httpServer := &http.Server{
			Addr:    ":" + defaultDevPort,
			Handler: srv.Handler(),
		}

		log.Fatal(httpServer.ListenAndServe())
		return
	}

	// Modo produção - HTTP e HTTPS
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	// Servidor HTTP (redirecionamento para HTTPS)
	httpServer := &http.Server{
		Addr: ":" + *httpPort,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			host := r.Host
			if host == "" {
				host = r.Header.Get("X-Forwarded-Host")
			}
			if host == "" {
				host = "localhost"
			}

			// Remove porta se presente
			if colonIndex := len(host) - 1; colonIndex > 0 {
				for i := colonIndex; i >= 0; i-- {
					if host[i] == ':' {
						host = host[:i]
						break
					}
				}
			}

			httpsURL := fmt.Sprintf("https://%s%s", host, r.RequestURI)
			log.Printf("🔄 Redirecionamento HTTP→HTTPS: %s → %s", r.URL.String(), httpsURL)
			http.Redirect(w, r, httpsURL, http.StatusMovedPermanently)
		}),
	}

	// Servidor HTTPS
	var httpsServer *http.Server
	if fileExists(*certFile) && fileExists(*keyFile) {
		httpsServer = &http.Server{
			Addr:    ":" + *httpsPort,
			Handler: srv.Handler(),
			TLSConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
			},
			TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
		}
		fmt.Printf("🔒 Certificados SSL encontrados\n")
		fmt.Printf("   Certificado: %s\n", *certFile)
		fmt.Printf("   Chave: %s\n", *keyFile)
	} else {
		fmt.Printf("⚠️  Certificados SSL não encontrados, rodando apenas HTTP\n")
	}

	// Inicia servidores em goroutines
	go func() {
		fmt.Printf("🌐 Servidor HTTP ativo na porta %s\n", *httpPort)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("❌ Erro no servidor HTTP: %v", err)
		}
	}()

	if httpsServer != nil {
		go func() {
			fmt.Printf("🔒 Servidor HTTPS ativo na porta %s\n", *httpsPort)
			if err := httpsServer.ListenAndServeTLS(*certFile, *keyFile); err != nil && err != http.ErrServerClosed {
				log.Fatalf("❌ Erro no servidor HTTPS: %v", err)
			}
		}()
	}

	fmt.Println(strings.Repeat("=", 80))
	fmt.Println("✅ TODOS OS SERVIDORES ATIVOS E FUNCIONANDO")
	fmt.Println("🔍 Logs detalhados de todas as atividades habilitados")
	fmt.Println(strings.Repeat("=", 80))

	// Aguarda sinal de encerramento
	<-sigChan
	fmt.Println("\n⏹️  Encerrando servidores...")

	// Graceful shutdown
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()

	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Printf("❌ Erro ao encerrar servidor HTTP: %v", err)
	}

	if httpsServer != nil {
		if err := httpsServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("❌ Erro ao encerrar servidor HTTPS: %v", err)
		}
	}

	fmt.Println("✅ Servidores encerrados com sucesso")
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func fileExists(filename string) bool {
	_, err := os.Stat(filename)
	return !os.IsNotExist(err)
}
