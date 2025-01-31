// import Main from './objects/summarize/Main.js';
import Main from './objects/translate/interfaces/EPUB.js';
// import Main from './objects/rewrite/interfaces/EPUB.js';

import Logger from './config/logger.js';

const epub = new Main({ path: process.argv[2] });

const write = () => {
  epub.on('writed', () => {
    Logger.info('EPUB - WRITED');

    process.exit();
  });

  epub.write();
};

const launch = () => {
  epub.on('processed', () => {
    Logger.info('EPUB - PROCESSED');

    write();
  });

  epub.process();
};

const parse = () => {
  epub.on('parsed', () => {
    Logger.info('EPUB - PARSED');

    launch();
  });

  epub.parse();
};

const init = () => {
  epub.on('initiated', () => {
    Logger.info('EPUB - INITIATED');

    setInterval(() => Logger.info(epub.getStatus()), 1000);

    parse();
  });

  epub.init();
};

(async () => {
  init();
})();
