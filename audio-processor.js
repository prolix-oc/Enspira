// ffmpeg-processor.js - Fixed version with proper promise handling
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from './create-global-logger.js';

/**
 * Processes audio using ffmpeg in a way that maximizes performance
 * @param {string} inputFilePath - Path to the input WAV file
 * @param {Object} options - Processing options
 * @returns {string} - Path to the processed file (synchronous return)
 */
export function processAudio(inputFilePath, options = {}) {
    const {
        enhanceVocals = true,
        outputDir = 'final',
        preset = 'clarity',
        userId = 'null'
    } = options;

    try {
        // Prepare paths
        const outputDirectory = path.resolve(process.cwd(), outputDir);
        const inputFileName = path.basename(inputFilePath, path.extname(inputFilePath));
        const outputFileName = `${userId}_${inputFileName}.wav`;
        const outputFilePath = path.join(outputDirectory, outputFileName);
        
        // Ensure output directory exists
        fs.ensureDirSync(outputDirectory);
        
        // Get filter string based on preset
        const filterString = enhanceVocals ? getPresetFilters(preset).join(',') : '';
        
        // Create the ffmpeg command
        const ffmpegCommand = `ffmpeg -y -i "${inputFilePath}" -af "${filterString}" -ar 44100 -ac 1 -codec:a pcm_s16le -threads 4 "${outputFilePath}"`;
        
        // Log the command
        logger.debug("Audio", `Executing command: ${ffmpegCommand}`);
        
        // Execute ffmpeg command synchronously
        execSync(ffmpegCommand, {
            stdio: ['ignore', 'ignore', 'pipe'] // Capture stderr only for errors
        });
        
        // Check that the output file exists
        if (!fs.existsSync(outputFilePath)) {
            throw new Error(`Output file was not created: ${outputFilePath}`);
        }
        
        logger.log("Audio", `Successfully processed audio to ${outputFilePath}`);
        return `/${outputFileName}`;
    } catch (error) {
        logger.error("Audio", `Error processing audio: ${error.message}`);
        throw error; // Re-throw to let caller handle it
    }
}

/**
 * Process multiple audio files in sequence
 * @param {Array<string>} inputFiles - Array of input file paths
 * @param {Object} options - Processing options
 * @returns {Array<string>} - Array of processed file paths
 */
export function batchProcessAudio(inputFiles, options = {}) {
    const results = [];
    for (const file of inputFiles) {
        const outputPath = processAudio(file, options);
        results.push(outputPath);
    }
    return results;
}

/**
 * Gets audio filters for the specified preset
 * @param {string} preset - Name of the preset
 * @returns {Array} - Array of filter strings
 */
function getPresetFilters(preset) {
    const basePresets = {
        clarity: [
            'highpass=f=150',
            'lowpass=f=11000',
            'equalizer=f=250:width_type=o:width=1:g=0.5',
            'equalizer=f=2500:width_type=o:width=1:g=1.5',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'equalizer=f=6000:width_type=o:width=1:g=-1',
            'compand=0.2|0.3:1|1:-90/-60|-60/-40|-40/-30|-20/-20:6:0:-90:0.2',
            'loudnorm=I=-16:TP=-1.5:LRA=11'
        ],
        warmVocal: [
            'highpass=f=100',
            'lowpass=f=11000',
            'equalizer=f=200:width_type=o:width=1:g=2',
            'equalizer=f=600:width_type=o:width=1:g=1',
            'equalizer=f=3000:width_type=o:width=1.5:g=1',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'compand=0.2|0.3:1|1:-90/-60|-60/-40|-40/-30|-20/-15:5:0:-90:0.3',
            'loudnorm=I=-16:TP=-1.5:LRA=10'
        ],
        brightVocal: [
            'highpass=f=130',
            'lowpass=f=12000',
            'equalizer=f=3000:width_type=o:width=1:g=2',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'equalizer=f=6000:width_type=o:width=1:g=0.5',
            'equalizer=f=200:width_type=o:width=1:g=-1',
            'compand=0.1|0.2:1|1:-90/-60|-60/-40|-40/-30|-20/-15:5:0:-90:0.1',
            'loudnorm=I=-14:TP=-1.5:LRA=6'
        ],
        smoothVocal: [
            'highpass=f=80',
            'lowpass=f=11000',
            'highshelf=f=6000:g=-6',
            'equalizer=f=2000:width_type=o:width=1:g=1',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'compand=0.3|0.5:1|1:-90/-60|-60/-40|-40/-30|-20/-15:4:0:-90:0.5',
            'loudnorm=I=-16:TP=-1.5:LRA=11'
        ],
        // Other presets remain the same but are omitted for brevity
    };
    
    return basePresets[preset] || basePresets.clarity;
}

/**
 * Cleans up files older than a specified number of days in a directory
 * @param {string} directory - Directory to clean up
 * @param {number} days - Delete files older than this many days (default: 5)
 * @return {Promise<number>} - Number of files deleted
 */
export async function cleanupOldFiles(directory, days = 5) {
    try {
        const now = Date.now();
        const cutoffTime = now - (days * 24 * 60 * 60 * 1000);

        const files = await fs.readdir(directory);
        let deletedCount = 0;

        for (const file of files) {
            const filePath = path.join(directory, file);

            try {
                const stats = await fs.stat(filePath);

                if (stats.isFile() && stats.ctimeMs < cutoffTime) {
                    await fs.unlink(filePath);
                    deletedCount++;
                }
            } catch (fileError) {
                logger.error("Audio", `Error processing file ${filePath}: ${fileError.message}`);
            }
        }

        return deletedCount;
    } catch (error) {
        logger.error("Audio", `Error cleaning up directory ${directory}: ${error.message}`);
        return 0;
    }
}

/**
 * Schedule automatic cleanup of a directory at regular intervals
 * @param {string} directory - Directory to clean up
 * @param {number} days - Delete files older than this many days (default: 5)
 * @param {number} intervalHours - How often to run cleanup in hours (default: 24)
 * @return {Object} - Timer object that can be cleared with clearInterval()
 */
export function scheduleCleanup(directory, days = 5, intervalHours = 24) {
    fs.mkdir(directory, { recursive: true })
        .catch(err => logger.error("Audio", `Error creating directory ${directory}: ${err.message}`));

    // Run cleanup immediately
    cleanupOldFiles(directory, days)
        .then(count => {
            if (count > 0) {
                logger.log("Audio", `Cleaned up ${count} old files from ${directory}`);
            }
        })
        .catch(err => logger.error("Audio", `Error in cleanup: ${err.message}`));

    const intervalMs = intervalHours * 60 * 60 * 1000;
    const timer = setInterval(() => {
        cleanupOldFiles(directory, days)
            .then(count => {
                if (count > 0) {
                    logger.log("Audio", `Cleaned up ${count} old files from ${directory}`);
                }
            })
            .catch(err => logger.error("Audio", `Error in scheduled cleanup: ${err.message}`));
    }, intervalMs);

    return timer;
}