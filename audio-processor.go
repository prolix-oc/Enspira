package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	ffmpeg "github.com/u2takey/ffmpeg-go"
)

// AudioRequest represents the incoming processing request
type AudioRequest struct {
	InputPath string   `json:"input_path"`
	Filters   []string `json:"filters"`
	Preset    string   `json:"preset,omitempty"`
	UserId    string   `json:"user_id,omitempty"`
}

// AudioResponse represents the server's response
type AudioResponse struct {
	Success    bool   `json:"success"`
	OutputFile string `json:"output_file"`
	Message    string `json:"message,omitempty"`
	Error      string `json:"error,omitempty"`
}

// Preset filters for different audio enhancement types
var presets = map[string][]string{
	"clarity": {
		"highpass=f=150",
		"lowpass=f=11000",
		"equalizer=f=250:width_type=o:width=1:g=0.5",
		"equalizer=f=2500:width_type=o:width=1:g=1.5",
		"equalizer=f=4000:width_type=q:width=20:g=-2",
		"equalizer=f=6000:width_type=o:width=1:g=-1",
		"compand=0.2|0.3:1|1:-90/-60|-60/-40|-40/-30|-20/-20:6:0:-90:0.2",
		"loudnorm=I=-16:TP=-1.5:LRA=11",
	},
	"warmVocal": {
		"highpass=f=100",
		"lowpass=f=11000",
		"equalizer=f=200:width_type=o:width=1:g=2",
		"equalizer=f=600:width_type=o:width=1:g=1",
		"equalizer=f=3000:width_type=o:width=1.5:g=1",
		"equalizer=f=4000:width_type=q:width=20:g=-2",
		"compand=0.2|0.3:1|1:-90/-60|-60/-40|-40/-30|-20/-15:5:0:-90:0.3",
		"loudnorm=I=-16:TP=-1.5:LRA=10",
	},
	"femaleVocal": {
		"highpass=f=150",
		"lowpass=f=12000",
		"equalizer=f=200:width_type=o:width=1.5:g=1.5",
		"equalizer=f=400:width_type=o:width=1:g=1",
		"equalizer=f=1200:width_type=o:width=1:g=-1",
		"equalizer=f=2500:width_type=o:width=1:g=1.5",
		"equalizer=f=4000:width_type=q:width=20:g=-2",
		"equalizer=f=5000:width_type=o:width=1:g=1",
		"highshelf=f=8000:g=-2",
		"compand=0.2|0.4:1|1:-90/-60|-60/-40|-40/-30|-20/-18:4:0:-90:0.4",
		"loudnorm=I=-16:TP=-1.5:LRA=9",
		"adeclick=window=55:overlap=75:arorder=8:threshold=2:burst=2:method=add",
	},
}

// Determine the project root directory
func getProjectRoot() string {
	// Get the directory where the binary is located
	execPath, err := os.Executable()
	if err != nil {
		log.Printf("Warning: Unable to determine executable path: %v", err)
		// Fall back to current working directory
		cwd, err := os.Getwd()
		if err != nil {
			log.Printf("Warning: Unable to determine current directory: %v", err)
			return "."
		}
		return cwd
	}
	
	execDir := filepath.Dir(execPath)
	
	// If the binary is in a 'bin' directory, go up one level
	if filepath.Base(execDir) == "bin" {
		return filepath.Dir(execDir)
	}
	
	// Otherwise, use the directory containing the binary
	return execDir
}

func main() {
	port := "3456" // Default port
	if len(os.Args) > 1 {
		port = os.Args[1]
	}

	// Get project root directory
	projectRoot := getProjectRoot()
	
	// Create final directory in the project root
	finalDir := filepath.Join(projectRoot, "final")
	err := os.MkdirAll(finalDir, 0755)
	if err != nil {
		log.Fatalf("Failed to create output directory: %v", err)
	}
	
	log.Printf("Project root: %s", projectRoot)
	log.Printf("Final output directory: %s", finalDir)

	http.HandleFunc("/process", func(w http.ResponseWriter, r *http.Request) {
		processAudioHandler(w, r, finalDir)
	})
	
	http.HandleFunc("/health", healthCheckHandler)

	fmt.Printf("Audio processor server listening on port %s...\n", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func healthCheckHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status": "ok",
		"time":   time.Now().Format(time.RFC3339),
	})
}

func processAudioHandler(w http.ResponseWriter, r *http.Request, finalDir string) {
	w.Header().Set("Content-Type", "application/json")

	// Parse request
	if r.Method != "POST" {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AudioRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		sendErrorResponse(w, "Invalid request format", http.StatusBadRequest)
		return
	}

	// Validate input path
	if req.InputPath == "" {
		sendErrorResponse(w, "Input path is required", http.StatusBadRequest)
		return
	}

	// Check if file exists
	if _, err := os.Stat(req.InputPath); os.IsNotExist(err) {
		sendErrorResponse(w, fmt.Sprintf("Input file not found: %s", req.InputPath), http.StatusBadRequest)
		return
	}

	// Get filters (either from preset or directly provided)
	var filters []string
	if req.Preset != "" {
		if presetFilters, ok := presets[req.Preset]; ok {
			filters = presetFilters
		} else {
			// If preset not found, fall back to default preset
			filters = presets["clarity"]
		}
	} else if len(req.Filters) > 0 {
		filters = req.Filters
	} else {
		// Default to clarity preset if no filters specified
		filters = presets["clarity"]
	}

	// Create output filename
	timestamp := strconv.FormatInt(time.Now().UnixNano()/1000000, 10)
	outputFileName := fmt.Sprintf("%s_%s.wav", req.UserId, timestamp)
	if req.UserId == "" {
		// If no user ID provided, use a simple timestamp
		outputFileName = fmt.Sprintf("processed_%s.wav", timestamp)
	}
	outputPath := filepath.Join(finalDir, outputFileName)

	// Process the audio
	err := processAudio(req.InputPath, outputPath, filters)
	if err != nil {
		sendErrorResponse(w, fmt.Sprintf("Error processing audio: %v", err), http.StatusInternalServerError)
		return
	}

	// Send success response
	resp := AudioResponse{
		Success:    true,
		OutputFile: outputFileName,
		Message:    "Audio processed successfully",
	}
	json.NewEncoder(w).Encode(resp)
}

func processAudio(inputPath, outputPath string, filters []string) error {
	// Join filters into a single comma-separated string
	filterString := strings.Join(filters, ",")
	
	// Build the ffmpeg command using the ffmpeg-go binding.
	// The KwArgs map corresponds to your command-line flags:
	// - "af": audio filters,
	// - "ar": sample rate,
	// - "ac": number of audio channels,
	// - "c:a": audio codec,
	// - "threads": thread count.
	err := ffmpeg.
		Input(inputPath).
		Output(outputPath, ffmpeg.KwArgs{
			"af":    filterString,
			"ar":    "48000",
			"ac":    "1",
			"c:a":   "pcm_s24le",
			"threads": "4",
		}).
		OverWriteOutput().
		Run()
	if err != nil {
		log.Printf("FFmpeg error: %v", err)
		return err
	}
	return nil
}

func sendErrorResponse(w http.ResponseWriter, errorMessage string, statusCode int) {
	w.WriteHeader(statusCode)
	resp := AudioResponse{
		Success: false,
		Error:   errorMessage,
	}
	json.NewEncoder(w).Encode(resp)
}