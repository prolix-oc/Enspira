// audioProcessor.js
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs-extra'

/**
 * Processes a WAV audio file by upsampling from 22050Hz to 44100Hz and enhancing vocal quality
 * @param {string} inputFilePath - Path to the input WAV file (from Alltalk-TTS)
 * @param {Object} options - Processing options
 * @param {boolean} options.enhanceVocals - Whether to apply vocal enhancement (default: true)
 * @param {string} options.outputDir - Directory to save the processed file (default: 'final')
 * @param {string} options.preset - Voice enhancement preset to use (default: 'clarity')
 * @return {Promise<string>} - Path to the processed audio file
 */
export async function processAudio(inputFilePath, options = {}) {
    const {
        enhanceVocals = true,
        outputDir = 'final',
        preset = 'clarity',
        userId = 'null'
    } = options;

    const audioFilters = enhanceVocals ? getPresetFilters(preset) : [];
    const outputDirectory = path.resolve(process.cwd(), outputDir);
    const inputFileName = path.basename(inputFilePath, path.extname(inputFilePath));
    const outputFileName = `${userId}_${inputFileName}.wav`;
    const outputFilePath = path.join(outputDirectory, outputFileName);

    // Ensure the output directory exists.
    try {
        await fs.promises.access(outputDirectory, fs.constants.W_OK);
    } catch (error) {
        await fs.promises.mkdir(outputDirectory, { recursive: true });
    }
    // Wrap ffmpeg in a promise so the function is asynchronous.
    return new Promise((resolve, reject) => {
        let command = ffmpeg(inputFilePath)
            .audioChannels(1)              // Force mono
            .audioFrequency(44100)         // Upsample to 48000 Hz
            .audioFilter(audioFilters)     // Apply your audio filters
            .format('wav')
            .audioCodec('pcm_s16le')       // 24-bit PCM
            .outputOptions(['-dither_method triangular_hp', '-threads 4', '-loglevel quiet'])
        command.save(outputFilePath)
            .on('end', () => resolve(outputFilePath))
            .on('error', (err) => reject(err));
    });
}

/**
 * Get audio filters based on preset name
 * @param {string} preset - Name of the preset to use
 * @return {Array} - Array of audio filter strings for ffmpeg
 */
function getPresetFilters(preset) {
    const basePresets = {
        clarityVocal: [
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
        richVocal: [
            'highpass=f=70',
            'lowpass=f=11000',
            'equalizer=f=120:width_type=o:width=1.5:g=3',
            'equalizer=f=250:width_type=o:width=1.5:g=2.5',
            'equalizer=f=400:width_type=o:width=1:g=1.5',
            'equalizer=f=800:width_type=q:width=4:g=-0.5',
            'equalizer=f=2500:width_type=o:width=1:g=1',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'compand=0.2|0.3:1|1:-90/-60|-60/-40|-40/-30|-20/-18:5:0:-90:0.3',
            'loudnorm=I=-16:TP=-1.5:LRA=10'
        ],
        broadcastSound: [
            'highpass=f=140',
            'lowpass=f=11000',
            'equalizer=f=120:width_type=o:width=1.5:g=3',
            'equalizer=f=250:width_type=o:width=1.5:g=2.5',
            'equalizer=f=500:width_type=o:width=1:g=1',
            'equalizer=f=800:width_type=o:width=1:g=-1',
            'equalizer=f=3000:width_type=o:width=1:g=2',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'equalizer=f=6000:width_type=o:width=1:g=1',
            'compand=0.1|0.2:1|1:-90/-60|-60/-40|-40/-30|-30/-20|-20/-10:4:0:-90:0.2',
            'volume=1.0',
            'alimiter=limit=0.9:attack=5:release=20',
            'loudnorm=I=-14:TP=-1:LRA=8',
        ],
        femaleVocal: [
            'highpass=f=150',
            'lowpass=f=12000',
            'equalizer=f=200:width_type=o:width=1.5:g=1.5',
            'equalizer=f=400:width_type=o:width=1:g=1',
            'equalizer=f=1200:width_type=o:width=1:g=-1',
            'equalizer=f=2500:width_type=o:width=1:g=1.5',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'equalizer=f=5000:width_type=o:width=1:g=1',
            'highshelf=f=8000:g=-2',
            'compand=0.2|0.4:1|1:-90/-60|-60/-40|-40/-30|-20/-18:4:0:-90:0.4',
            'loudnorm=I=-16:TP=-1.5:LRA=9',
            'adeclick=window=55:overlap=75:arorder=8:threshold=2:burst=2:method=add'
        ],
        deepBass: [
            'highpass=f=50',
            'lowpass=f=11000',
            'equalizer=f=80:width_type=o:width=1.2:g=4',
            'equalizer=f=200:width_type=o:width=1:g=2',
            'equalizer=f=500:width_type=q:width=4:g=-2',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'compand=0.3|0.5:1|1:-90/-70|-70/-50|-50/-30|-20/-15:5:0:-90:0.3',
            'loudnorm=I=-17:TP=-2:LRA=12'
        ],

        telephone: [
            'highpass=f=300',
            'lowpass=f=3400',
            'equalizer=f=1000:width_type=o:width=0.7:g=4',
            'compand=0.1|0.1:1|1:-90/-40|-40/-20|-20/-10|-10/-5:3:0:-90:0.1',
            'loudnorm=I=-14:TP=-3:LRA=5'
        ],

        presenceBoost: [
            'highpass=f=150',
            'lowpass=f=11000',
            'equalizer=f=200:width_type=o:width=1:g=-1',
            'equalizer=f=2500:width_type=o:width=1.5:g=3',
            'equalizer=f=4000:width_type=q:width=20:g=-3',
            'equalizer=f=6000:width_type=o:width=1:g=2',
            'compand=0.1|0.2:1|1:-90/-60|-60/-40|-40/-30|-20/-15:6:0:-90:0.1',
            'loudnorm=I=-15:TP=-1.5:LRA=7'
        ],
        deBoom: [
            'highpass=f=100',
            'lowpass=f=11000',
            'equalizer=f=150:width_type=q:width=5:g=-4',
            'equalizer=f=300:width_type=q:width=4:g=-2',
            'equalizer=f=2500:width_type=o:width=1:g=1',
            'equalizer=f=4000:width_type=q:width=20:g=-2',
            'compand=0.2|0.3:1|1:-90/-60|-60/-40|-40/-30|-20/-18:6:0:-90:0.2',
            'loudnorm=I=-16:TP=-1.5:LRA=10'
        ],
        gentleCurve: [
            'highpass=f=100',
            'lowpass=f=11000',
            'equalizer=f=100:width_type=o:width=1.5:g=1',
            'equalizer=f=500:width_type=q:width=3:g=-1',
            'equalizer=f=3000:width_type=o:width=1.2:g=1',
            'equalizer=f=4000:width_type=q:width=20:g=-1',
            'compand=0.3|0.5:1|1:-90/-65|-65/-45|-45/-30|-20/-15:6:0:-90:0.3',
            'loudnorm=I=-16:TP=-1.5:LRA=11'
        ],

        thinToFull: [
            'highpass=f=85',
            'lowpass=f=11000',
            'equalizer=f=180:width_type=o:width=1.5:g=3',
            'equalizer=f=350:width_type=o:width=1.2:g=2',
            'equalizer=f=2800:width_type=o:width=1:g=1',
            'equalizer=f=4000:width_type=q:width=20:g=-2.5',
            'compand=0.2|0.4:1|1:-90/-60|-60/-40|-40/-30|-20/-17:5:0:-90:0.2',
            'loudnorm=I=-16.5:TP=-1.8:LRA=10'
        ]
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
                console.error(`Error processing file ${filePath}:`, fileError);
            }
        }

        return deletedCount;
    } catch (error) {
        console.error(`Error cleaning up directory ${directory}:`, error);
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
        .catch(err => console.error(`Error creating directory ${directory}:`, err));

    // Run cleanup immediately
    cleanupOldFiles(directory, days)
        .then(count => {
            if (count > 0) {
                console.log(`Cleaned up ${count} old files from ${directory}`);
            }
        })
        .catch(err => console.error('Error in cleanup:', err));

    const intervalMs = intervalHours * 60 * 60 * 1000;
    const timer = setInterval(() => {
        cleanupOldFiles(directory, days)
            .then(count => {
                if (count > 0) {
                    console.log(`Cleaned up ${count} old files from ${directory}`);
                }
            })
            .catch(err => console.error('Error in scheduled cleanup:', err));
    }, intervalMs);

    return timer;
}
