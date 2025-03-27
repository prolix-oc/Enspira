// template-engine.js
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs-extra';
import { logger } from './create-global-logger.js';
import nunjucks from 'nunjucks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function setupTemplating(fastify) {
  // Ensure templates directory exists
  const templatesDir = path.join(process.cwd(), 'views');
  await fs.ensureDir(templatesDir);
  
  // Move templates from pages to views if needed
  const pagesDir = path.join(process.cwd(), 'pages');
  if (await fs.pathExists(pagesDir)) {
    const pageFiles = await fs.readdir(pagesDir);
    for (const file of pageFiles) {
      const sourcePath = path.join(pagesDir, file);
      const destPath = path.join(templatesDir, file);
      
      // Skip if destination already exists
      if (!(await fs.pathExists(destPath))) {
        await fs.copy(sourcePath, destPath);
        logger.log("Templates", `Copied template: ${file}`);
      }
    }
  }
  
  // Create Nunjucks environment directly
  const njkEnv = nunjucks.configure(templatesDir, {
    autoescape: true,
    throwOnUndefined: false,
    trimBlocks: true,
    lstripBlocks: true
  });
  
  // Add template helpers/filters
  njkEnv.addFilter('json', (obj) => JSON.stringify(obj, null, 2));
  njkEnv.addFilter('dateFormat', async (date, format = 'MMMM Do YYYY, h:mm a') => {
    if (!date) return '';
    const moment = (await import('moment')).default;
    return moment(date).format(format);
  });
  
  // Add direct view rendering to Fastify
  fastify.decorate('renderView', (template, data = {}) => {
    return njkEnv.render(template, { 
      ...data, 
      appName: 'Enspira',
      year: new Date().getFullYear()
    });
  });
  
  // Add direct view rendering to reply object
  fastify.decorateReply('view', function(template, data = {}) {
    const html = njkEnv.render(template, { 
      ...data, 
      appName: 'Enspira',
      year: new Date().getFullYear()
    });
    return this.type('text/html').send(html);
  });
  
  logger.log("System", "Template engine configured successfully");
  return fastify;
}