/* eslint-disable max-len */

export default (data) =>
  [
    `Informações gerais:`,
    `- Objetivo: Traduzir o conteúdo de um livro escrito em ${data.source} para ${data.destination}`,
    `Restrições de tradução:`,
    `- O conteúdo é apresentado no formato JSON`,
    `- Apenas os valores do JSON devem ser traduzidos`,
    `- As chaves do JSON, incluindo caminhos de arquivo e UUIDs, não devem ser alteradas`,
    `- Os espaços nas strings de caracteres devem ser preservados`,
    `- A estrutura do JSON traduzido deve ser idêntica à original`,
    `Detalhes do livro:`,
    `- Nome: ${data.book_title}`,
    `- Escrito por: ${data.book_author}`,
    `Conteúdo a ser traduzido:`,
    JSON.stringify(data.content),
  ].join('\n');
