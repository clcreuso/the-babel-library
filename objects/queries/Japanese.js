export default (data) =>
  [
    `一般情報:`,
    `- 目的：${data.source}で書かれた本の内容を${data.destination}に翻訳する`,
    `翻訳の制約:`,
    `- 内容はJSON形式で提示される`,
    `- JSONの値のみを翻訳する`,
    `- ファイルパスやUUIDを含むJSONキーは変更しない`,
    `- 文字列内のスペースは保持する`,
    `- 翻訳されたJSONの構造はオリジナルと同じでなければならない`,
    `本の詳細:`,
    `- 名前：${data.book_title}`,
    `- 著者：${data.book_author}`,
    `翻訳する内容:`,
    JSON.stringify(data.content, null, 2),
  ].join('\n');
