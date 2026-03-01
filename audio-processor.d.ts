/**
 * Type declarations for audio-processor.js
 * This stub enables TypeScript imports during the migration.
 */

export interface ProcessAudioOptions {
  enhanceVocals?: boolean;
  outputDir?: string;
  preset?: 'clarity' | 'warmVocal' | 'brightVocal' | string;
  userId?: string;
}

/**
 * Processes audio using ffmpeg in a way that maximizes performance
 * @param inputFilePath - Path to the input WAV file
 * @param options - Processing options
 * @returns Path to the processed file (synchronous return)
 */
export function processAudio(
  inputFilePath: string,
  options?: ProcessAudioOptions
): string;

/**
 * Process multiple audio files in sequence
 * @param inputFiles - Array of input file paths
 * @param options - Processing options
 * @returns Array of processed file paths
 */
export function batchProcessAudio(
  inputFiles: string[],
  options?: ProcessAudioOptions
): string[];

/**
 * Clean up old audio files from a directory
 * @param directory - Directory to clean
 * @param days - Age threshold in days (default 5)
 */
export function cleanupOldFiles(
  directory: string,
  days?: number
): Promise<void>;

/**
 * Schedule periodic cleanup of old files
 * @param directory - Directory to clean
 * @param days - Age threshold in days (default 5)
 * @param intervalHours - Cleanup interval in hours (default 24)
 */
export function scheduleCleanup(
  directory: string,
  days?: number,
  intervalHours?: number
): void;
