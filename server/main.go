package main

import (
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"
)

const defaultPort = "2580"

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	logger := log.New(os.Stdout, "", 0)

	mux := http.NewServeMux()
	mux.HandleFunc("/2.0/", handleAPI(logger))
	mux.HandleFunc("/2.0", handleAPI(logger))
	// Some clients hit the root path
	mux.HandleFunc("/", handleAPI(logger))

	addr := ":" + port
	logger.Printf("Last.fm compatible API server starting on %s", addr)
	logger.Printf("Endpoints: POST/GET http://localhost:%s/2.0/", port)

	server := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	if err := server.ListenAndServe(); err != nil {
		logger.Fatalf("Server failed: %v", err)
	}
}

func handleAPI(logger *log.Logger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		timestamp := time.Now().UTC().Format("2006-01-02T15:04:05Z")

		logger.Printf("=== %s %s %s from %s ===", timestamp, r.Method, r.URL.Path, r.RemoteAddr)

		// Log all request headers
		logger.Printf("--- Headers ---")
		headerKeys := make([]string, 0, len(r.Header))
		for k := range r.Header {
			headerKeys = append(headerKeys, k)
		}
		sort.Strings(headerKeys)
		for _, k := range headerKeys {
			logger.Printf("  %s: %s", k, strings.Join(r.Header[k], ", "))
		}

		// Log query parameters
		queryParams := r.URL.Query()
		if len(queryParams) > 0 {
			logger.Printf("--- Query Parameters ---")
			logParams(logger, queryParams)
		}

		// Read and log POST body
		var postParams url.Values
		var rawBody string

		if r.Method == http.MethodPost {
			bodyBytes, err := io.ReadAll(r.Body)
			if err != nil {
				logger.Printf("  Error reading body: %v", err)
				http.Error(w, "error reading request body", http.StatusBadRequest)
				return
			}
			defer r.Body.Close()

			rawBody = string(bodyBytes)
			logger.Printf("--- POST Body (raw) ---")
			logger.Printf("  %s", rawBody)

			// Try to parse as form-encoded
			postParams, err = url.ParseQuery(rawBody)
			if err == nil && len(postParams) > 0 {
				logger.Printf("--- POST Parameters (parsed) ---")
				logParams(logger, postParams)
			}
		}

		// Determine the API method from either query or post params
		method := queryParams.Get("method")
		if method == "" && postParams != nil {
			method = postParams.Get("method")
		}

		if method != "" {
			logger.Printf("--- API Method: %s ---", method)
		} else {
			logger.Printf("--- API Method: (not specified) ---")
		}

		logger.Printf("=== End Request ===")
		logger.Println()

		// Merge all params (POST takes precedence)
		allParams := mergeParams(queryParams, postParams)

		// Route to the appropriate handler based on method
		switch strings.ToLower(method) {
		case "auth.getmobilesession":
			handleAuthGetMobileSession(w, r, allParams, logger)
		case "auth.gettoken":
			handleAuthGetToken(w, r, allParams, logger)
		case "auth.getsession":
			handleAuthGetSession(w, r, allParams, logger)
		case "track.updatenowplaying":
			handleTrackUpdateNowPlaying(w, r, allParams, logger)
		case "track.scrobble":
			handleTrackScrobble(w, r, allParams, logger)
		case "track.love":
			handleTrackLove(w, r, allParams, logger)
		case "track.unlove":
			handleTrackUnlove(w, r, allParams, logger)
		case "track.getinfo":
			handleTrackGetInfo(w, r, allParams, logger)
		case "user.getinfo":
			handleUserGetInfo(w, r, allParams, logger)
		case "user.getrecenttracks":
			handleUserGetRecentTracks(w, r, allParams, logger)
		default:
			handleUnknownMethod(w, r, method, allParams, logger)
		}
	}
}

func logParams(logger *log.Logger, params url.Values) {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		for _, v := range params[k] {
			logger.Printf("  %s = %s", k, v)
		}
	}
}

func mergeParams(query, post url.Values) url.Values {
	merged := url.Values{}
	for k, v := range query {
		merged[k] = v
	}
	if post != nil {
		for k, v := range post {
			merged[k] = v
		}
	}
	return merged
}

// respondXML writes an XML response with the given status and body.
// Last.fm API returns XML by default unless format=json is specified.
func respondXML(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprint(w, `<?xml version="1.0" encoding="UTF-8"?>`)
	fmt.Fprint(w, body)
}

func respondJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	fmt.Fprint(w, body)
}

func respond(w http.ResponseWriter, r *http.Request, params url.Values, status int, xmlBody, jsonBody string) {
	format := params.Get("format")
	if strings.EqualFold(format, "json") {
		respondJSON(w, status, jsonBody)
	} else {
		respondXML(w, status, xmlBody)
	}
}

// --- Auth Handlers ---

func handleAuthGetMobileSession(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	username := params.Get("username")
	logger.Printf("[auth.getMobileSession] username=%s", username)

	// Return a dummy session key - this is just a logging server for now
	sk := "dummy-session-key-000000000000"

	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><session><name>%s</name><key>%s</key><subscriber>0</subscriber></session></lfm>`, username, sk),
		fmt.Sprintf(`{"session":{"name":"%s","key":"%s","subscriber":0}}`, username, sk),
	)
}

func handleAuthGetToken(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	logger.Printf("[auth.getToken] request received")

	token := "dummy-token-000000000000000000"

	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><token>%s</token></lfm>`, token),
		fmt.Sprintf(`{"token":"%s"}`, token),
	)
}

func handleAuthGetSession(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	token := params.Get("token")
	logger.Printf("[auth.getSession] token=%s", token)

	sk := "dummy-session-key-000000000000"

	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><session><name>user</name><key>%s</key><subscriber>0</subscriber></session></lfm>`, sk),
		fmt.Sprintf(`{"session":{"name":"user","key":"%s","subscriber":0}}`, sk),
	)
}

// --- Track Handlers ---

func handleTrackUpdateNowPlaying(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	artist := params.Get("artist")
	track := params.Get("track")
	album := params.Get("album")
	duration := params.Get("duration")

	logger.Printf("[track.updateNowPlaying] artist=%q track=%q album=%q duration=%s", artist, track, album, duration)

	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><nowplaying><track corrected="0">%s</track><artist corrected="0">%s</artist><album corrected="0">%s</album><albumArtist corrected="0"></albumArtist><ignoredMessage code="0"></ignoredMessage></nowplaying></lfm>`, track, artist, album),
		fmt.Sprintf(`{"nowplaying":{"artist":{"corrected":"0","#text":"%s"},"track":{"corrected":"0","#text":"%s"},"album":{"corrected":"0","#text":"%s"},"albumArtist":{"corrected":"0","#text":""},"ignoredMessage":{"code":"0","#text":""}}}`, artist, track, album),
	)
}

func handleTrackScrobble(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	// Handle both single scrobble and batch scrobble (array notation)
	// Single: artist, track, timestamp
	// Batch: artist[0], track[0], timestamp[0], artist[1], ...

	type scrobbleEntry struct {
		Artist    string
		Track     string
		Album     string
		Timestamp string
	}

	var entries []scrobbleEntry

	// Check for batch notation
	if params.Get("artist[0]") != "" {
		for i := 0; i < 50; i++ {
			prefix := fmt.Sprintf("[%d]", i)
			artist := params.Get("artist" + prefix)
			if artist == "" {
				break
			}
			entries = append(entries, scrobbleEntry{
				Artist:    artist,
				Track:     params.Get("track" + prefix),
				Album:     params.Get("album" + prefix),
				Timestamp: params.Get("timestamp" + prefix),
			})
		}
	} else if params.Get("artist") != "" {
		// Single scrobble
		entries = append(entries, scrobbleEntry{
			Artist:    params.Get("artist"),
			Track:     params.Get("track"),
			Album:     params.Get("album"),
			Timestamp: params.Get("timestamp"),
		})
	}

	logger.Printf("[track.scrobble] %d track(s) scrobbled:", len(entries))
	for i, e := range entries {
		logger.Printf("  [%d] artist=%q track=%q album=%q timestamp=%s", i, e.Artist, e.Track, e.Album, e.Timestamp)
	}

	// Build response
	var xmlScrobbles string
	var jsonScrobbles string
	for _, e := range entries {
		xmlScrobbles += fmt.Sprintf(`<scrobble><track corrected="0">%s</track><artist corrected="0">%s</artist><album corrected="0">%s</album><albumArtist corrected="0"></albumArtist><ignoredMessage code="0"></ignoredMessage><timestamp>%s</timestamp></scrobble>`, e.Track, e.Artist, e.Album, e.Timestamp)
	}

	if len(entries) == 1 {
		e := entries[0]
		jsonScrobbles = fmt.Sprintf(`{"artist":{"corrected":"0","#text":"%s"},"track":{"corrected":"0","#text":"%s"},"album":{"corrected":"0","#text":"%s"},"albumArtist":{"corrected":"0","#text":""},"ignoredMessage":{"code":"0","#text":""},"timestamp":"%s"}`, e.Artist, e.Track, e.Album, e.Timestamp)
	} else {
		var parts []string
		for _, e := range entries {
			parts = append(parts, fmt.Sprintf(`{"artist":{"corrected":"0","#text":"%s"},"track":{"corrected":"0","#text":"%s"},"album":{"corrected":"0","#text":"%s"},"albumArtist":{"corrected":"0","#text":""},"ignoredMessage":{"code":"0","#text":""},"timestamp":"%s"}`, e.Artist, e.Track, e.Album, e.Timestamp))
		}
		jsonScrobbles = "[" + strings.Join(parts, ",") + "]"
	}

	accepted := len(entries)
	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><scrobbles accepted="%d" ignored="0">%s</scrobbles></lfm>`, accepted, xmlScrobbles),
		fmt.Sprintf(`{"scrobbles":{"@attr":{"accepted":%d,"ignored":0},"scrobble":%s}}`, accepted, jsonScrobbles),
	)
}

func handleTrackLove(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	artist := params.Get("artist")
	track := params.Get("track")
	logger.Printf("[track.love] artist=%q track=%q", artist, track)

	respond(w, r, params, http.StatusOK,
		`<lfm status="ok"></lfm>`,
		`{"status":"ok"}`,
	)
}

func handleTrackUnlove(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	artist := params.Get("artist")
	track := params.Get("track")
	logger.Printf("[track.unlove] artist=%q track=%q", artist, track)

	respond(w, r, params, http.StatusOK,
		`<lfm status="ok"></lfm>`,
		`{"status":"ok"}`,
	)
}

func handleTrackGetInfo(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	artist := params.Get("artist")
	track := params.Get("track")
	logger.Printf("[track.getInfo] artist=%q track=%q", artist, track)

	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><track><name>%s</name><artist><name>%s</name></artist><listeners>0</listeners><playcount>0</playcount></track></lfm>`, track, artist),
		fmt.Sprintf(`{"track":{"name":"%s","artist":{"name":"%s"},"listeners":"0","playcount":"0"}}`, track, artist),
	)
}

// --- User Handlers ---

func handleUserGetInfo(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	user := params.Get("user")
	if user == "" {
		user = params.Get("username")
	}
	logger.Printf("[user.getInfo] user=%q", user)

	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><user><name>%s</name><playcount>0</playcount><registered unixtime="0">2000-01-01 00:00</registered></user></lfm>`, user),
		fmt.Sprintf(`{"user":{"name":"%s","playcount":"0","registered":{"unixtime":"0","#text":"2000-01-01 00:00"}}}`, user),
	)
}

func handleUserGetRecentTracks(w http.ResponseWriter, r *http.Request, params url.Values, logger *log.Logger) {
	user := params.Get("user")
	logger.Printf("[user.getRecentTracks] user=%q", user)

	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="ok"><recenttracks user="%s" page="1" perPage="50" totalPages="0" total="0"></recenttracks></lfm>`, user),
		fmt.Sprintf(`{"recenttracks":{"track":[],"@attr":{"user":"%s","totalPages":"0","page":"1","perPage":"50","total":"0"}}}`, user),
	)
}

// --- Fallback ---

func handleUnknownMethod(w http.ResponseWriter, r *http.Request, method string, params url.Values, logger *log.Logger) {
	if method == "" {
		logger.Printf("[unknown] No method specified")
		respond(w, r, params, http.StatusBadRequest,
			`<lfm status="failed"><error code="3"><message>Invalid Method - No method name supplied</message></error></lfm>`,
			`{"error":3,"message":"Invalid Method - No method name supplied"}`,
		)
		return
	}

	logger.Printf("[unknown] Unhandled method: %s", method)
	respond(w, r, params, http.StatusOK,
		fmt.Sprintf(`<lfm status="failed"><error code="3"><message>Invalid Method - method not yet implemented: %s</message></error></lfm>`, method),
		fmt.Sprintf(`{"error":3,"message":"Invalid Method - method not yet implemented: %s"}`, method),
	)
}
