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
  njkEnv.addFilter('startsWithMarkdown', (text) => {
    if (!text) return false;
    const trimmedText = text.trim();
    // Check for common markdown patterns
    return /^(#|\*|\-|\d+\.|>|\[|\`|\!\[)/.test(trimmedText);
  });
  
  // Basic markdown renderer for simple cases
  njkEnv.addFilter('renderMarkdown', (text) => {
    if (!text) return '';
    
    let html = text;
    
    // Headers
    html = html.replace(/^# (.*$)/gm, '<h1>$1</h1>');
    html = html.replace(/^## (.*$)/gm, '<h2>$1</h2>');
    html = html.replace(/^### (.*$)/gm, '<h3>$1</h3>');
    
    // Lists
    html = html.replace(/^\- (.*$)/gm, '<li>$1</li>');
    html = html.replace(/^(\d+)\. (.*$)/gm, '<li>$2</li>');
    
    // Wrap list items in ul/ol
    html = html.replace(/(<li>.*<\/li>)\s+(?!<li>)/gs, '<ul>$1</ul>');
    
    // Bold and italics
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    
    // Paragraphs (non-list, non-header text)
    html = html.replace(/^(?!<h|<ul|<li|<ol)(.*$)/gm, '<p>$1</p>');
    
    return html;
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