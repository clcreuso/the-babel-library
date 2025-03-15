import Youtube from './objects/youtube/Main.js';
import Summarize from './objects/summarize/Main.js';
import Dictionary from './objects/dictionary/Main.js';
import Rewrite from './objects/rewrite/interfaces/EPUB.js';
import Translate from './objects/translate/interfaces/EPUB.js';
import Logger from './config/logger.js';

const COMMANDS = {
  '-r': Rewrite,
  '-t': Translate,
  '-s': Summarize,
  '-y': Youtube,
  '-d': Dictionary,
};

class EPUBProcessor {
  constructor() {
    this.epub = null;
  }

  createProcessor() {
    const [, , command = '-t', argument] = process.argv;

    if (!argument) {
      throw new Error('Missing required argument');
    }

    const ProcessorClass = COMMANDS[command] || Translate;

    let options;

    switch (command) {
      case '-y':
        options = { id: argument };
        break;
      case '-d':
        options = { theme: argument };
        break;
      default:
        options = { path: argument };
    }

    this.epub = new ProcessorClass(options);
    return this;
  }

  async processWithLogging(stage, action) {
    return new Promise((resolve) => {
      this.epub.on(stage, () => {
        Logger.info(`EPUB - ${stage.toUpperCase()}`);
        resolve();
      });
      action();
    });
  }

  startStatusLogging() {
    return setInterval(() => Logger.info(this.epub.getStatus()), 1000);
  }

  async run() {
    try {
      await this.processWithLogging('initiated', () => this.epub.init());

      const statusInterval = this.startStatusLogging();

      await this.processWithLogging('parsed', () => this.epub.parse());
      await this.processWithLogging('processed', () => this.epub.process());
      await this.processWithLogging('writed', () => this.epub.write());

      clearInterval(statusInterval);

      Logger.info('Processing completed successfully');

      process.exit(0);
    } catch (error) {
      Logger.error('Error during processing:', error);

      process.exit(1);
    }
  }
}

(async () => {
  try {
    const processor = new EPUBProcessor();

    await processor.createProcessor().run();
  } catch (error) {
    Logger.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
