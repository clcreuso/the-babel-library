<div align="center">
   <h1 align="center">The Babel Library</h1>
   <br>
   <img src="/images/cover.png" width="50%">
</div>

<br>

   
The Babel Library is a Node.js script that translates EPUB files from one language to another using the OpenAI API. It leverages the power of artificial intelligence to provide automated translation capabilities for EPUB books.

## Prerequisites

Before running the script, make sure you have the following dependencies installed:

- Node.js (version 14 or higher)
- npm (Node Package Manager)

## Configuration

1. Clone the repository and navigate to the project directory.

2. Install the required dependencies by running the following command:

```
   npm install
```

## Configuring `.env` for OpenAI

This guide will help you set up a `.env` file to securely store your OpenAI API key and Org ID. Follow the steps below for a secure configuration.

### 1. Find the Organization ID

To locate your Organization ID:

- Navigate to your [OpenAI Dashboard](https://platform.openai.com/account/org-settings).
- Look under the "Organization -> Settings" heading in the left column. Your Organization ID will be listed there.

<div align="center">
   <img src="/images/docs/org_id.png" width="50%">
</div>

### 2. Add a Payment Method

Before you can create an API key, you must have a valid payment method on file:

- In the dashboard, click on "Organization -> Billing -> Payment methods" in the left column.
- Follow the prompts to add a new payment method.
  
<div align="center">
   <img src="/images/docs/payment_method.png" width="50%">
</div>

### 3. Create an API Key

- On the dashboard, navigate to the "User -> API Keys" section.
- Click on "Create new key".
- Give your key a recognizable name and select the appropriate scope.
   
<div align="center">
   <img src="/images/docs/create_key.png" width="50%">
</div>


### 4. Copy the API Key

- Once the key is generated, click on the "copy" icon next to the key.
- Keep this key safe. For security reasons, OpenAI will only display the full key once.

<div align="center">
   <img src="/images/docs/paste_key.png" width="50%">
</div>

### 5. Create the `.env` File and Copy Over the Org ID and API Key

In the root of your project, create a file named `.env`. Add the following lines, replacing `***` with your actual information:

```env
OPENAI_ORG=***
OPENAI_KEY=***
```

<div align="center">
   <img src="/images/docs/env_file.png" width="50%">
</div>

## Usage

To translate an EPUB file, update the `script.js` file with the desired parameters:

```javascript
const translationParams = {
  ...
  source: 'English', // Source language of the EPUB file
  destination: 'French', // Destination language for translation
};
```

Specify the source language and destination language for translation as desired.

Run the script by executing the following command:

```
node script.js path/to/your/file.epub
```

The script will translate the EPUB file and create a translated version in the destination language.

## Video Usage

<div align="center">
   <br>

  <a href="https://www.youtube.com/watch?v=KOSUYIr-Cfs"><img src="/images/docs/youtube_img.png" width="50%" alt="Tuto on Youtube"></a>
</div>

## Notes

    - JSON parsing errors (API response) are not serious.
    - If an error persists, you will either need to lower the value of MAX_TOKENS or 
    manually add the translation to ./db/Database.json.
    - For languages like Chinese, it is possible that certain fields are not translated.
    In that case, you will need to remove them from ./db/Database.json and rerun the 
    script, or translate them manually and modify them in ./db/Database.json.
    - Fix: consistency check (word and character ratio), macro translation (paragraph grouping)
    - Stable version: starting from August 5, 2023
    - Complete documentation: coming soon...

## License

This project is licensed under the MIT License. Feel free to modify and use it according to your needs.

## Disclaimer

Please note that this script relies on the OpenAI API for translation. Make sure you comply with the OpenAI usage guidelines and any applicable terms and conditions.
