package main

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v3"
)

type config struct {
	whipURL    string
	authToken  string
	listenAddr string
	codec      string
	logRTP     bool
	firstRTPTimeout time.Duration
}

func main() {
	cfg := parseFlags()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := run(ctx, cfg); err != nil {
		log.Fatalf("fatal: %v", err)
	}
}

func parseFlags() config {
	var cfg config
	flag.StringVar(&cfg.whipURL, "whip-url", envOr("WHIP_URL", "http://103.124.94.194:8889/cam1/whip"), "WHIP endpoint URL")
	flag.StringVar(&cfg.authToken, "auth-token", envOr("WHIP_AUTH_TOKEN", ""), "Optional bearer token for WHIP auth")
	flag.StringVar(&cfg.listenAddr, "listen-addr", envOr("RTP_LISTEN_ADDR", "127.0.0.1:5004"), "UDP address for incoming RTP")
	flag.StringVar(&cfg.codec, "codec", strings.ToUpper(envOr("VIDEO_CODEC", "H264")), "Video codec: H264")
	flag.BoolVar(&cfg.logRTP, "log-rtp", envOr("LOG_RTP", "0") == "1", "Log RTP packet stats periodically")
	flag.DurationVar(&cfg.firstRTPTimeout, "first-rtp-timeout", durationEnvOr("FIRST_RTP_TIMEOUT", 12*time.Second), "Maximum wait for first RTP packet before WHIP publish")
	flag.Parse()

	return cfg
}

func durationEnvOr(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func run(ctx context.Context, cfg config) error {
	if cfg.codec != "H264" {
		return fmt.Errorf("unsupported codec %q, only H264 is supported", cfg.codec)
	}

	udpConn, err := net.ListenPacket("udp", cfg.listenAddr)
	if err != nil {
		return fmt.Errorf("listen udp %s: %w", cfg.listenAddr, err)
	}
	defer udpConn.Close()

	log.Printf("waiting first RTP on udp://%s (timeout=%s)", cfg.listenAddr, cfg.firstRTPTimeout)
	firstPacket, err := waitFirstRTPPacket(ctx, udpConn, cfg.firstRTPTimeout)
	if err != nil {
		return err
	}
	log.Printf("first RTP received: seq=%d ts=%d marker=%v", firstPacket.SequenceNumber, firstPacket.Timestamp, firstPacket.Marker)

	mediaEngine := &webrtc.MediaEngine{}
	if err = mediaEngine.RegisterDefaultCodecs(); err != nil {
		return fmt.Errorf("register default codecs: %w", err)
	}

	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return fmt.Errorf("new peer connection: %w", err)
	}
	defer pc.Close()

	track, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
		"video",
		"pion-whip",
	)
	if err != nil {
		return fmt.Errorf("create local track: %w", err)
	}

	rtpSender, err := pc.AddTrack(track)
	if err != nil {
		return fmt.Errorf("add track: %w", err)
	}

	go func() {
		rtcpBuf := make([]byte, 1500)
		for {
			if _, _, readErr := rtpSender.Read(rtcpBuf); readErr != nil {
				return
			}
		}
	}()

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("peer connection state: %s", state.String())
	})

	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		log.Printf("ice state: %s", state.String())
	})

	resourceURL, err := negotiateWHIP(ctx, pc, cfg)
	if err != nil {
		return err
	}

	if writeErr := track.WriteRTP(firstPacket); writeErr != nil {
		if errors.Is(writeErr, io.ErrClosedPipe) {
			return nil
		}
		return fmt.Errorf("write first RTP to track: %w", writeErr)
	}

	log.Printf("streaming RTP from udp://%s", cfg.listenAddr)
	log.Printf("publishing to WHIP: %s", cfg.whipURL)
	if resourceURL != "" {
		log.Printf("WHIP resource: %s", resourceURL)
	}

	rtpBuf := make([]byte, 1600)
	packet := &rtp.Packet{}

	var packets uint64 = 1
	var lastLog time.Time
	for {
		select {
		case <-ctx.Done():
			if resourceURL != "" {
				if delErr := deleteWHIPResource(resourceURL, cfg.authToken); delErr != nil {
					log.Printf("failed to DELETE WHIP resource: %v", delErr)
				}
			}
			return nil
		default:
		}

		if err := udpConn.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
			return fmt.Errorf("set read deadline: %w", err)
		}

		n, _, readErr := udpConn.ReadFrom(rtpBuf)
		if readErr != nil {
			var netErr net.Error
			if errors.As(readErr, &netErr) && netErr.Timeout() {
				continue
			}
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("udp read: %w", readErr)
		}

		if unmarshalErr := packet.Unmarshal(rtpBuf[:n]); unmarshalErr != nil {
			continue
		}

		if writeErr := track.WriteRTP(packet); writeErr != nil {
			if errors.Is(writeErr, io.ErrClosedPipe) {
				return nil
			}
			return fmt.Errorf("write RTP to track: %w", writeErr)
		}

		packets++
		if cfg.logRTP && time.Since(lastLog) >= 2*time.Second {
			lastLog = time.Now()
			log.Printf("rtp packets sent: %d", packets)
		}
	}
}

func waitFirstRTPPacket(ctx context.Context, udpConn net.PacketConn, timeout time.Duration) (*rtp.Packet, error) {
	deadline := time.Now().Add(timeout)
	rtpBuf := make([]byte, 1600)
	packet := &rtp.Packet{}

	for {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("timeout waiting first RTP on %s", udpConn.LocalAddr().String())
		}

		if err := udpConn.SetReadDeadline(time.Now().Add(1 * time.Second)); err != nil {
			return nil, fmt.Errorf("set read deadline: %w", err)
		}

		n, _, readErr := udpConn.ReadFrom(rtpBuf)
		if readErr != nil {
			var netErr net.Error
			if errors.As(readErr, &netErr) && netErr.Timeout() {
				continue
			}
			return nil, fmt.Errorf("udp read while waiting first RTP: %w", readErr)
		}

		if unmarshalErr := packet.Unmarshal(rtpBuf[:n]); unmarshalErr != nil {
			continue
		}

		return packet, nil
	}
}

func negotiateWHIP(ctx context.Context, pc *webrtc.PeerConnection, cfg config) (string, error) {
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return "", fmt.Errorf("create offer: %w", err)
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err = pc.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("set local description: %w", err)
	}

	select {
	case <-gatherComplete:
	case <-ctx.Done():
		return "", ctx.Err()
	case <-time.After(8 * time.Second):
		log.Printf("warning: ICE gathering timeout, continuing with current SDP")
	}

	local := pc.LocalDescription()
	if local == nil {
		return "", errors.New("local description is nil")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.whipURL, bytes.NewBufferString(local.SDP))
	if err != nil {
		return "", fmt.Errorf("build WHIP request: %w", err)
	}
	req.Header.Set("Content-Type", "application/sdp")
	if cfg.authToken != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.authToken)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("WHIP POST: %w", err)
	}
	defer resp.Body.Close()

	answerSDPBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read WHIP response: %w", err)
	}

	if resp.StatusCode != http.StatusCreated {
		return "", fmt.Errorf("WHIP POST status=%d body=%s", resp.StatusCode, string(answerSDPBytes))
	}

	if err = pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  string(answerSDPBytes),
	}); err != nil {
		return "", fmt.Errorf("set remote description: %w", err)
	}

	resourceURL := resp.Header.Get("Location")
	if resourceURL != "" {
		resourceURL = absolutizeURL(cfg.whipURL, resourceURL)
	}

	return resourceURL, nil
}

func absolutizeURL(baseURL, resource string) string {
	if strings.HasPrefix(resource, "http://") || strings.HasPrefix(resource, "https://") {
		return resource
	}
	base := strings.TrimSuffix(baseURL, "/")
	if strings.HasPrefix(resource, "/") {
		split := strings.Split(base, "/")
		if len(split) >= 3 {
			return split[0] + "//" + split[2] + resource
		}
		return base + resource
	}
	return base + "/" + resource
}

func deleteWHIPResource(resourceURL string, authToken string) error {
	req, err := http.NewRequest(http.MethodDelete, resourceURL, nil)
	if err != nil {
		return err
	}
	if authToken != "" {
		req.Header.Set("Authorization", "Bearer "+authToken)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("DELETE status=%d body=%s", resp.StatusCode, string(body))
	}
	return nil
}