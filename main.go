package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
)

func main() {
	http.HandleFunc("/2.0/", handleAPI)
	http.HandleFunc("/2.0", handleAPI)

	log.Println("Starting Last.fm compatible API server on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, r, 3, "Invalid Method - Only POST is supported")
		return
	}

	if err := r.ParseForm(); err != nil {
		writeError(w, r, 6, "Invalid parameters")
		return
	}

	method := r.FormValue("method")
	if method == "" {
		writeError(w, r, 3, "Invalid Method - No method parameter supplied")
		return
	}

	logParams(r)

	switch strings.ToLower(method) {
	case "track.updatenowplaying":
		handleNowPlaying(w, r)
	case "track.scrobble":
		handleScrobble(w, r)
	default:
		writeError(w, r, 3, fmt.Sprintf("Invalid Method - method %q not implemented", method))
	}
}

func logParams(r *http.Request) {
	keys := make([]string, 0, len(r.PostForm))
	for k := range r.PostForm {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	log.Printf("--- %s %s ---", r.Method, r.URL.Path)
	for _, k := range keys {
		values := r.PostForm[k]
		for _, v := range values {
			log.Printf("  %s = %s", k, v)
		}
	}
	log.Println("---")
}

// handleNowPlaying handles track.updateNowPlaying.
//
// Required params: artist, track, api_key, api_sig, sk
// Optional params: album, trackNumber, context, mbid, duration, albumArtist
func handleNowPlaying(w http.ResponseWriter, r *http.Request) {
	artist := r.FormValue("artist")
	track := r.FormValue("track")

	if artist == "" || track == "" {
		writeError(w, r, 6, "Invalid parameters - artist and track are required")
		return
	}

	log.Printf("[nowplaying] artist=%q track=%q album=%q",
		artist, track, r.FormValue("album"))

	resp := NowPlayingResponse{
		NowPlaying: NowPlayingData{
			Artist:      textField(artist),
			Track:       textField(track),
			Album:       textField(r.FormValue("album")),
			AlbumArtist: textField(r.FormValue("albumArtist")),
			IgnoredMessage: IgnoredMessage{
				Code: "0",
			},
		},
		Attr: StatusAttr{Status: "ok"},
	}

	writeJSON(w, r, resp)
}

// handleScrobble handles track.scrobble.
//
// Supports both single and batch scrobbles.
// Single: artist, track, timestamp
// Batch:  artist[0], track[0], timestamp[0], artist[1], track[1], timestamp[1], ...
//
// Required params per scrobble: artist, track, timestamp, api_key, api_sig, sk
// Optional params per scrobble: album, trackNumber, context, mbid, duration, albumArtist, streamId, chosenByUser
func handleScrobble(w http.ResponseWriter, r *http.Request) {
	scrobbles := parseScrobbles(r)
	if len(scrobbles) == 0 {
		writeError(w, r, 6, "Invalid parameters - at least one scrobble with artist, track, and timestamp is required")
		return
	}

	accepted := make([]ScrobbleEntry, 0, len(scrobbles))
	for _, s := range scrobbles {
		log.Printf("[scrobble] artist=%q track=%q timestamp=%q album=%q",
			s.Artist, s.Track, s.Timestamp, s.Album)

		accepted = append(accepted, ScrobbleEntry{
			Artist:      textField(s.Artist),
			Track:       textField(s.Track),
			Album:       textField(s.Album),
			AlbumArtist: textField(s.AlbumArtist),
			Timestamp:   s.Timestamp,
			IgnoredMessage: IgnoredMessage{
				Code: "0",
			},
		})
	}

	resp := ScrobbleResponse{
		Scrobbles: ScrobbleData{
			Scrobble: accepted,
			Attr: ScrobbleAttr{
				Accepted: len(accepted),
				Ignored:  0,
			},
		},
		Attr: StatusAttr{Status: "ok"},
	}

	writeJSON(w, r, resp)
}

type scrobbleInput struct {
	Artist      string
	Track       string
	Timestamp   string
	Album       string
	AlbumArtist string
}

// parseScrobbles extracts scrobble data from the request.
// It handles both non-indexed (artist, track, timestamp) and
// indexed (artist[0], track[0], timestamp[0]) parameter formats.
func parseScrobbles(r *http.Request) []scrobbleInput {
	// Check for non-indexed format first.
	if artist := r.FormValue("artist"); artist != "" {
		if track := r.FormValue("track"); track != "" {
			if ts := r.FormValue("timestamp"); ts != "" {
				return []scrobbleInput{{
					Artist:      artist,
					Track:       track,
					Timestamp:   ts,
					Album:       r.FormValue("album"),
					AlbumArtist: r.FormValue("albumArtist"),
				}}
			}
		}
	}

	// Indexed format: artist[0], track[0], timestamp[0], ...
	var results []scrobbleInput
	for i := 0; i < 50; i++ {
		idx := fmt.Sprintf("[%d]", i)
		artist := r.FormValue("artist" + idx)
		track := r.FormValue("track" + idx)
		ts := r.FormValue("timestamp" + idx)

		if artist == "" || track == "" || ts == "" {
			continue
		}

		results = append(results, scrobbleInput{
			Artist:      artist,
			Track:       track,
			Timestamp:   ts,
			Album:       r.FormValue("album" + idx),
			AlbumArtist: r.FormValue("albumArtist" + idx),
		})
	}

	return results
}

// --- Response types ---

type StatusAttr struct {
	Status string `json:"status"`
}

type IgnoredMessage struct {
	Code string `json:"code"`
	Text string `json:"#text,omitempty"`
}

type TextField struct {
	Corrected string `json:"corrected,omitempty"`
	Text      string `json:"#text"`
}

func textField(s string) TextField {
	return TextField{Text: s}
}

type NowPlayingData struct {
	Artist         TextField      `json:"artist"`
	Track          TextField      `json:"track"`
	Album          TextField      `json:"album"`
	AlbumArtist    TextField      `json:"albumArtist"`
	IgnoredMessage IgnoredMessage `json:"ignoredMessage"`
}

type NowPlayingResponse struct {
	NowPlaying NowPlayingData `json:"nowplaying"`
	Attr       StatusAttr     `json:"@attr"`
}

type ScrobbleEntry struct {
	Artist         TextField      `json:"artist"`
	Track          TextField      `json:"track"`
	Album          TextField      `json:"album"`
	AlbumArtist    TextField      `json:"albumArtist"`
	Timestamp      string         `json:"timestamp"`
	IgnoredMessage IgnoredMessage `json:"ignoredMessage"`
}

type ScrobbleData struct {
	Scrobble []ScrobbleEntry `json:"scrobble"`
	Attr     ScrobbleAttr    `json:"@attr"`
}

type ScrobbleAttr struct {
	Accepted int `json:"accepted"`
	Ignored  int `json:"ignored"`
}

type ScrobbleResponse struct {
	Scrobbles ScrobbleData `json:"scrobbles"`
	Attr      StatusAttr   `json:"@attr"`
}

type ErrorResponse struct {
	Error   int    `json:"error"`
	Message string `json:"message"`
}

// --- Helpers ---

func wantsJSON(r *http.Request) bool {
	return r.FormValue("format") == "json"
}

func writeJSON(w http.ResponseWriter, r *http.Request, data any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, r *http.Request, code int, message string) {
	log.Printf("[error] code=%d message=%q", code, message)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	json.NewEncoder(w).Encode(ErrorResponse{
		Error:   code,
		Message: message,
	})
}
