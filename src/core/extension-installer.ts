/**
 * Extension Installer - Installs extensions from git repos and local paths
 * Handles cloning, dependency installation, and building
 * @module core/extension-installer
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { access, mkdir, rm, readFile, readdir, cp } from 'fs/promises';
import { join, basename, resolve } from 'path';
import type { ExtensionLoadResult } from '@/types/extension.types.js';
import { getLogger, type Logger } from './logger.js';
import { getExtensionLoader, type ExtensionLoader } from './extension-loader.js';

const execAsync = promisify(exec);

// ==================== CONSTANTS ====================

/** Default extensions directory */
const DEFAULT_EXTENSIONS_DIR = './extensions/installed';

/** Default data directory for extension storage */
const DEFAULT_DATA_DIR = './extensions/data';

/** Git clone timeout in milliseconds */
const GIT_TIMEOUT_MS = 60000;

/** NPM install timeout in milliseconds */
const NPM_TIMEOUT_MS = 120000;

/** Build timeout in milliseconds */
const BUILD_TIMEOUT_MS = 180000;

// ==================== EXTENSION INSTALLER CLASS ====================

/**
 * Installer for extensions from various sources
 */
export class ExtensionInstaller {
  private logger: Logger;
  private loader: ExtensionLoader;
  private extensionsDir: string;
  private dataDir: string;

  constructor(options: ExtensionInstallerOptions = {}) {
    this.logger = getLogger();
    this.loader = options.loader || getExtensionLoader();
    this.extensionsDir = resolve(options.extensionsDir || DEFAULT_EXTENSIONS_DIR);
    this.dataDir = resolve(options.dataDir || DEFAULT_DATA_DIR);
  }

  // ==================== GIT INSTALLATION ====================

  /**
   * Install an extension from a git repository
   * @param url - Git repository URL
   * @param options - Installation options
   */
  async installFromGit(
    url: string,
    options: InstallOptions = {}
  ): Promise<ExtensionLoadResult> {
    const repoName = this.extractRepoName(url);
    const targetDir = join(this.extensionsDir, repoName);

    this.logger.info('ExtensionInstaller', `Installing extension from ${url}`);

    try {
      // Ensure directories exist
      await this.ensureDirectories();

      // Check if already installed
      if (await this.exists(targetDir)) {
        if (options.overwrite) {
          this.logger.info('ExtensionInstaller', `Removing existing installation at ${targetDir}`);
          await rm(targetDir, { recursive: true, force: true });
        } else {
          return {
            success: false,
            error: `Extension already installed at ${targetDir}. Use overwrite option to replace.`,
          };
        }
      }

      // Clone the repository
      await this.gitClone(url, targetDir, options.branch);

      // Install dependencies if package.json exists
      if (await this.exists(join(targetDir, 'package.json'))) {
        await this.npmInstall(targetDir);
      }

      // Build if build script exists
      await this.runBuildIfExists(targetDir);

      // Load the extension
      const result = await this.loader.load(targetDir, {
        autoEnable: options.autoEnable ?? true,
      });

      if (result.success) {
        this.logger.info('ExtensionInstaller', `Successfully installed ${result.extensionId}`);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('ExtensionInstaller', `Installation failed: ${errorMessage}`);

      // Clean up on failure
      try {
        await rm(targetDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Update an installed extension from git
   * @param extensionId - Extension ID to update
   */
  async updateFromGit(extensionId: string): Promise<ExtensionLoadResult> {
    const loaded = this.loader['registry'].get(extensionId);
    if (!loaded) {
      return {
        success: false,
        error: `Extension ${extensionId} is not installed`,
      };
    }

    const extensionPath = loaded.path;
    this.logger.info('ExtensionInstaller', `Updating extension ${extensionId}`);

    try {
      // Git pull
      await this.gitPull(extensionPath);

      // Reinstall dependencies
      if (await this.exists(join(extensionPath, 'package.json'))) {
        await this.npmInstall(extensionPath);
      }

      // Rebuild
      await this.runBuildIfExists(extensionPath);

      // Reload the extension
      return await this.loader.reload(extensionId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('ExtensionInstaller', `Update failed: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ==================== LOCAL INSTALLATION ====================

  /**
   * Install an extension from a local directory
   * @param sourcePath - Path to extension directory
   * @param options - Installation options
   */
  async installFromLocal(
    sourcePath: string,
    options: InstallOptions = {}
  ): Promise<ExtensionLoadResult> {
    const resolvedPath = resolve(sourcePath);
    const dirName = basename(resolvedPath);
    const targetDir = join(this.extensionsDir, dirName);

    this.logger.info('ExtensionInstaller', `Installing extension from ${resolvedPath}`);

    try {
      // Ensure directories exist
      await this.ensureDirectories();

      // Validate source exists
      if (!(await this.exists(resolvedPath))) {
        return {
          success: false,
          error: `Source directory not found: ${resolvedPath}`,
        };
      }

      // Check for manifest
      if (!(await this.exists(join(resolvedPath, 'manifest.json')))) {
        return {
          success: false,
          error: 'No manifest.json found in source directory',
        };
      }

      // Check if already installed
      if (await this.exists(targetDir)) {
        if (options.overwrite) {
          await rm(targetDir, { recursive: true, force: true });
        } else {
          return {
            success: false,
            error: `Extension already installed at ${targetDir}`,
          };
        }
      }

      // Copy to extensions directory
      if (options.symlink) {
        // Create symlink for development
        await this.createSymlink(resolvedPath, targetDir);
      } else {
        // Copy files
        await cp(resolvedPath, targetDir, { recursive: true });
      }

      // Install dependencies if needed
      if (await this.exists(join(targetDir, 'package.json'))) {
        await this.npmInstall(targetDir);
      }

      // Load the extension
      return await this.loader.load(targetDir, {
        autoEnable: options.autoEnable ?? true,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('ExtensionInstaller', `Installation failed: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ==================== UNINSTALLATION ====================

  /**
   * Uninstall an extension
   * @param extensionId - Extension ID to uninstall
   * @param options - Uninstall options
   */
  async uninstall(
    extensionId: string,
    options: UninstallOptions = {}
  ): Promise<{ success: boolean; error?: string }> {
    const registry = this.loader['registry'] as any;
    const loaded = registry.get(extensionId);

    if (!loaded) {
      return {
        success: false,
        error: `Extension ${extensionId} is not installed`,
      };
    }

    const extensionPath = loaded.path;
    this.logger.info('ExtensionInstaller', `Uninstalling extension ${extensionId}`);

    try {
      // Unregister from registry
      await registry.unregister(extensionId);

      // Remove extension files
      await rm(extensionPath, { recursive: true, force: true });

      // Remove data if requested
      if (options.removeData) {
        const dataPath = join(this.dataDir, `${extensionId}.sqlite`);
        try {
          await rm(dataPath, { force: true });
        } catch {
          // Ignore if data doesn't exist
        }
      }

      this.logger.info('ExtensionInstaller', `Successfully uninstalled ${extensionId}`);

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('ExtensionInstaller', `Uninstall failed: ${errorMessage}`);

      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  // ==================== GIT OPERATIONS ====================

  /**
   * Clone a git repository
   */
  private async gitClone(url: string, targetDir: string, branch?: string): Promise<void> {
    let command = `git clone --depth 1`;
    if (branch) {
      command += ` --branch ${branch}`;
    }
    command += ` ${url} "${targetDir}"`;

    this.logger.debug('ExtensionInstaller', `Running: ${command}`);

    await execAsync(command, { timeout: GIT_TIMEOUT_MS });
  }

  /**
   * Pull latest changes from git
   */
  private async gitPull(path: string): Promise<void> {
    const command = `git -C "${path}" pull --ff-only`;
    this.logger.debug('ExtensionInstaller', `Running: ${command}`);

    await execAsync(command, { timeout: GIT_TIMEOUT_MS });
  }

  // ==================== NPM OPERATIONS ====================

  /**
   * Run npm install in a directory
   */
  private async npmInstall(path: string): Promise<void> {
    this.logger.info('ExtensionInstaller', `Installing dependencies in ${path}`);

    // Prefer bun if available, fall back to npm
    const packageManager = await this.detectPackageManager();
    const command = `cd "${path}" && ${packageManager} install`;

    this.logger.debug('ExtensionInstaller', `Running: ${command}`);

    await execAsync(command, { timeout: NPM_TIMEOUT_MS });
  }

  /**
   * Detect available package manager
   */
  private async detectPackageManager(): Promise<string> {
    try {
      await execAsync('bun --version', { timeout: 5000 });
      return 'bun';
    } catch {
      // Bun not available, use npm
      return 'npm';
    }
  }

  /**
   * Run build script if it exists
   */
  private async runBuildIfExists(path: string): Promise<void> {
    const packageJsonPath = join(path, 'package.json');

    if (!(await this.exists(packageJsonPath))) {
      return;
    }

    try {
      const content = await readFile(packageJsonPath, 'utf-8');
      const pkg = JSON.parse(content);

      if (pkg.scripts?.build) {
        this.logger.info('ExtensionInstaller', `Building extension in ${path}`);

        const packageManager = await this.detectPackageManager();
        const command = `cd "${path}" && ${packageManager} run build`;

        this.logger.debug('ExtensionInstaller', `Running: ${command}`);

        await execAsync(command, { timeout: BUILD_TIMEOUT_MS });
      }
    } catch (error) {
      throw new Error(`Build failed: ${error}`);
    }
  }

  // ==================== UTILITIES ====================

  /**
   * Extract repository name from git URL
   */
  private extractRepoName(url: string): string {
    // Handle various git URL formats
    // https://github.com/user/repo.git
    // git@github.com:user/repo.git
    // https://github.com/user/repo

    let name = url
      .replace(/\.git$/, '')
      .split('/')
      .pop() || '';

    // Handle SSH format
    if (name.includes(':')) {
      name = name.split(':').pop() || '';
    }

    return name || 'extension';
  }

  /**
   * Check if path exists
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure required directories exist
   */
  private async ensureDirectories(): Promise<void> {
    await mkdir(this.extensionsDir, { recursive: true });
    await mkdir(this.dataDir, { recursive: true });
  }

  /**
   * Create a symlink
   */
  private async createSymlink(source: string, target: string): Promise<void> {
    const { symlink } = await import('fs/promises');
    await symlink(source, target, 'dir');
  }

  /**
   * List installed extensions
   */
  async listInstalled(): Promise<InstalledExtensionInfo[]> {
    const result: InstalledExtensionInfo[] = [];

    try {
      const entries = await readdir(this.extensionsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const extensionPath = join(this.extensionsDir, entry.name);
        const manifestPath = join(extensionPath, 'manifest.json');

        try {
          const content = await readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(content);

          result.push({
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            path: extensionPath,
            hasGit: await this.exists(join(extensionPath, '.git')),
          });
        } catch {
          // Skip entries without valid manifest
        }
      }
    } catch {
      // Extensions directory doesn't exist
    }

    return result;
  }

  // ==================== CONFIGURATION ====================

  /**
   * Set extensions directory
   */
  setExtensionsDir(dir: string): void {
    this.extensionsDir = resolve(dir);
  }

  /**
   * Set data directory
   */
  setDataDir(dir: string): void {
    this.dataDir = resolve(dir);
  }
}

// ==================== TYPES ====================

export interface ExtensionInstallerOptions {
  extensionsDir?: string;
  dataDir?: string;
  loader?: ExtensionLoader;
}

export interface InstallOptions {
  /** Branch to clone (for git installs) */
  branch?: string;
  /** Overwrite existing installation */
  overwrite?: boolean;
  /** Auto-enable after installation */
  autoEnable?: boolean;
  /** Create symlink instead of copy (for local installs) */
  symlink?: boolean;
}

export interface UninstallOptions {
  /** Remove extension data as well */
  removeData?: boolean;
}

export interface InstalledExtensionInfo {
  id: string;
  name: string;
  version: string;
  path: string;
  hasGit: boolean;
}

// ==================== SINGLETON INSTANCE ====================

let installerInstance: ExtensionInstaller | null = null;

/**
 * Get or create the global extension installer instance
 */
export function getExtensionInstaller(): ExtensionInstaller {
  if (!installerInstance) {
    installerInstance = new ExtensionInstaller();
  }
  return installerInstance;
}

/**
 * Create a new extension installer instance
 */
export function createExtensionInstaller(
  options?: ExtensionInstallerOptions
): ExtensionInstaller {
  return new ExtensionInstaller(options);
}

/**
 * Reset the global extension installer instance (for testing)
 */
export function resetExtensionInstaller(): void {
  installerInstance = null;
}
