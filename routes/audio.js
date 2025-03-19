// routes/audio.js
import path from 'path';
import fastifyStatic from '@fastify/static';
import fs from 'fs/promises';

export async function audioRoutes(fastify, options = {}) {
  const {
    outputDir = 'final',
    addContentDisposition = false
  } = options;

  // Resolve the absolute path to the output directory
  const audioFilesPath = path.resolve(process.cwd(), outputDir);
  
  console.log('Audio files directory:', audioFilesPath);
  
  // Simple test route to verify the plugin is working
  fastify.get('/test', async () => {
    return { status: 'Audio routes working' };
  });
  
  // Direct file serving
  fastify.get('/:filename', async (request, reply) => {
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
      console.error('Error serving file:', error);
      return reply.code(error.code === 'ENOENT' ? 404 : 500)
        .send({ error: error.code === 'ENOENT' ? 'File not found' : 'Error serving file' });
    }
  });
  
  // Register static file plugin as a separate handler
  await fastify.register(fastifyStatic, {
    root: audioFilesPath,
    prefix: '/static',
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader('Content-Type', 'audio/wav');
      if (addContentDisposition) {
        const filePath = req.url;
        const fileName = path.basename(filePath);
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      }
    }
  });
  
  // Add a delete route
  fastify.delete('/:filename', async (request, reply) => {
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
      if (error.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      return reply.code(500).send({ error: 'Failed to delete file' });
    }
  });
}