// src/routes/audio.ts
import path from 'path';
import fastifyStatic from '@fastify/static';
import fs from 'fs/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

/** Options for audio routes */
export interface AudioRoutesOptions {
  outputDir?: string;
  addContentDisposition?: boolean;
}

/** Params for filename routes */
interface FilenameParams {
  filename: string;
}

/**
 * Audio routes plugin for serving audio files
 */
export async function audioRoutes(
  fastify: FastifyInstance,
  options: AudioRoutesOptions = {}
): Promise<void> {
  const { outputDir = 'final', addContentDisposition = false } = options;

  // Resolve the absolute path to the output directory
  const audioFilesPath = path.resolve(process.cwd(), outputDir);

  console.log('Audio files directory:', audioFilesPath);

  // Simple test route to verify the plugin is working
  fastify.get('/test', async (): Promise<{ status: string }> => {
    return { status: 'Audio routes working' };
  });

  // Direct file serving
  fastify.get<{ Params: FilenameParams }>(
    '/:filename',
    async (request: FastifyRequest<{ Params: FilenameParams }>, reply: FastifyReply) => {
      const { filename } = request.params;

      // Prevent path traversal
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return reply.code(400).send({ error: 'Invalid filename' });
      }

      const filePath = path.join(audioFilesPath, filename);

      try {
        // Verify file exists
        await fs.access(filePath);

        // Set headers manually
        reply.header('Content-Type', 'audio/wav');

        if (addContentDisposition) {
          reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        }

        // Read and send file directly
        const fileContent = await fs.readFile(filePath);
        return reply.send(fileContent);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        console.error('Error serving file:', err);
        return reply
          .code(err.code === 'ENOENT' ? 404 : 500)
          .send({ error: err.code === 'ENOENT' ? 'File not found' : 'Error serving file' });
      }
    }
  );

  // Register static file plugin as a separate handler
  await fastify.register(fastifyStatic, {
    root: audioFilesPath,
    prefix: '/static',
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'audio/wav');
      if (addContentDisposition) {
        // Note: In the original code, 'req' was used but not available in this scope
        // This is a known limitation - content disposition won't work properly for static files
      }
    },
  });

  // Add a delete route
  fastify.delete<{ Params: FilenameParams }>(
    '/:filename',
    async (
      request: FastifyRequest<{ Params: FilenameParams }>,
      reply: FastifyReply
    ): Promise<{ success: boolean; message: string } | void> => {
      const { filename } = request.params;

      // Prevent path traversal
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return reply.code(400).send({ error: 'Invalid filename' });
      }

      const filePath = path.join(audioFilesPath, filename);

      try {
        await fs.unlink(filePath);
        return { success: true, message: `File ${filename} deleted` };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return reply.code(404).send({ error: 'File not found' });
        }
        return reply.code(500).send({ error: 'Failed to delete file' });
      }
    }
  );
}

export default audioRoutes;
