// Load environment variables (works on Railway and local)
try {
    require('dotenv').config();
} catch (error) {
    console.log('📦 dotenv not found, using Railway environment variables');
}

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { OpenAI } = require('openai');

// ========== LOAD ENVIRONMENT VARIABLES ==========
// Railway automatically injects environment variables
const {
    OPENAI_API_KEY,
    PASTEFY_API_KEY,
    BOT_PREFIX = '.@banana code helper',
    AI_MODEL = 'gpt-4',
    AI_TEMPERATURE = 0.8,
    AI_MAX_TOKENS = 1000,
    IMAGE_SIZE = '1024x1024',
    IMAGE_MODEL = 'dall-e-3',
    MAX_HISTORY = 10,
    AUTO_ACTIVATE_ON_GREETING = 'true',
    TEMP_FOLDER = 'temp',
    PASTEFY_URL = 'https://pastefy.app/api/v2/pastes',
    PASTEFY_ENCRYPTED = 'false',
    // Railway specific
    RAILWAY_ENVIRONMENT = 'false',
    PORT = '3000'
} = process.env;

// ========== VALIDATE API KEYS ==========
if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is required!');
    console.error('💡 Set it in Railway environment variables');
    process.exit(1);
}

if (!PASTEFY_API_KEY) {
    console.warn('⚠️ PASTEFY_API_KEY not found. Pastefy features will be disabled.');
}

console.log('🚀 Starting WhatsApp AI Bot on Railway...');
console.log(`🔧 Environment: ${RAILWAY_ENVIRONMENT === 'true' ? 'Railway' : 'Local'}`);
console.log(`🤖 AI Model: ${AI_MODEL}`);
console.log(`💬 Max history: ${MAX_HISTORY} messages`);

// ========== INITIALIZE CLIENT ==========
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, 'session') // Railway persistent storage
    }),
    puppeteer: { 
        headless: true, 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu'
        ]
    }
});

const openai = new OpenAI({ 
    apiKey: OPENAI_API_KEY 
});

// ========== GLOBAL VARIABLES ==========
let botActive = false;
const activeUsers = new Set();
const conversationHistory = new Map();

// ========== ENSURE TEMP FOLDER EXISTS ==========
const tempPath = path.join(__dirname, TEMP_FOLDER);
if (!fs.existsSync(tempPath)) {
    fs.mkdirSync(tempPath, { recursive: true });
    console.log(`📁 Created temp folder: ${tempPath}`);
}

// ========== SESSION MANAGEMENT FOR RAILWAY ==========
const sessionPath = path.join(__dirname, 'session');
if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
    console.log(`📁 Created session folder: ${sessionPath}`);
}

// ========== GENERATE QR ==========
client.on('qr', qr => {
    console.log('📱 SCAN THIS QR CODE WITH WHATSAPP:');
    qrcode.generate(qr, { small: true });
    console.log('💡 QR Code generated! Scan it within 2 minutes.');
    
    // Also log the QR as text for Railway logs
    console.log('📱 QR Code URL:', qr);
});

client.on('ready', () => {
    console.log('✅ Bot connected successfully to WhatsApp!');
    console.log(`📱 Bot is ready to receive messages`);
    console.log(`🔧 Prefix: ${BOT_PREFIX}`);
    console.log(`🤖 AI Model: ${AI_MODEL}`);
    console.log(`🌐 Running on Railway: ${RAILWAY_ENVIRONMENT === 'true' ? 'Yes' : 'No'}`);
    botActive = true;
});

client.on('authenticated', (session) => {
    console.log('✅ WhatsApp authentication successful!');
    console.log('💾 Session saved for next runs');
});

// ========== HELPER FUNCTIONS ==========

/**
 * Upload text to Pastefy
 */
async function uploadToPastefy(text, title = 'Document') {
    if (!PASTEFY_API_KEY) {
        console.warn('⚠️ Pastefy API key not configured');
        return null;
    }
    
    try {
        const response = await axios.post(PASTEFY_URL, {
            content: text,
            title: title,
            encrypted: PASTEFY_ENCRYPTED === 'true'
        }, {
            headers: {
                'Authorization': `Bearer ${PASTEFY_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        return `https://pastefy.app/${response.data.id}`;
    } catch (error) {
        console.error('❌ Error uploading to Pastefy:', error.response?.data || error.message);
        return null;
    }
}

/**
 * Generate image with DALL-E
 */
async function generateImage(prompt) {
    try {
        const response = await openai.images.generate({
            model: IMAGE_MODEL,
            prompt: prompt,
            n: 1,
            size: IMAGE_SIZE
        });
        return response.data[0].url;
    } catch (error) {
        console.error('❌ Error generating image:', error.response?.data || error.message);
        return null;
    }
}

/**
 * Ask AI with context
 */
async function askAI(question, context = []) {
    try {
        const messages = [
            { 
                role: "system", 
                content: `You are a helpful and friendly assistant. Respond naturally to any message. Be conversational and human-like. You can help with any topic.
                         Current date: ${new Date().toLocaleDateString()}
                         Current time: ${new Date().toLocaleTimeString()}`
            }
        ];
        
        // Add conversation context
        if (context.length > 0) {
            const maxHistory = parseInt(MAX_HISTORY);
            const recentContext = context.slice(-maxHistory * 2);
            messages.push(...recentContext);
        }
        
        messages.push({ role: "user", content: question });
        
        const response = await openai.chat.completions.create({
            model: AI_MODEL,
            messages: messages,
            temperature: parseFloat(AI_TEMPERATURE),
            max_tokens: parseInt(AI_MAX_TOKENS)
        });
        
        return response.choices[0].message.content;
    } catch (error) {
        console.error('❌ Error consulting AI:', error.response?.data || error.message);
        return '❌ Error consulting AI. Please try again.';
    }
}

/**
 * Save file to temp folder
 */
function saveFile(content, filename) {
    try {
        const filePath = path.join(tempPath, filename);
        fs.writeFileSync(filePath, content);
        return filePath;
    } catch (error) {
        console.error('❌ Error saving file:', error);
        return null;
    }
}

/**
 * Check if message is a greeting
 */
function isGreeting(text) {
    const greetings = ['hola', 'hello', 'hi', 'hey', 'buenas', 'que tal', 'como estas', 'how are you'];
    return greetings.some(g => text.toLowerCase().includes(g));
}

/**
 * Extract file creation request from message
 */
function extractFileRequest(text) {
    const patterns = [
        /create\s+(?:a\s+)?file\s+(?:called\s+)?([^\s]+)\s+(?:with\s+)?(?:content\s+)?(.+)/i,
        /file\s+([^\s]+)\s+(.+)/i,
        /crear\s+(?:un\s+)?archivo\s+(?:llamado\s+)?([^\s]+)\s+(?:con\s+)?(?:contenido\s+)?(.+)/i
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return { filename: match[1], content: match[2] };
        }
    }
    return null;
}

/**
 * Extract image generation request from message
 */
function extractImageRequest(text) {
    const patterns = [
        /create\s+(?:an\s+)?image\s+(?:of\s+)?(.+)/i,
        /generate\s+(?:an\s+)?image\s+(?:of\s+)?(.+)/i,
        /imagen\s+(?:de\s+)?(.+)/i,
        /image\s+(?:of\s+)?(.+)/i,
        /dibuja\s+(?:un\s+)?(.+)/i
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            return match[1];
        }
    }
    return null;
}

/**
 * Extract Pastefy upload request from message
 */
function extractPastefyRequest(text) {
    const patterns = [
        /upload\s+(?:to\s+)?pastefy\s+(?:called\s+)?([^\s]+)?\s*(.+)/i,
        /pastefy\s+(?:called\s+)?([^\s]+)?\s*(.+)/i,
        /subir\s+(?:a\s+)?pastefy\s+(?:llamado\s+)?([^\s]+)?\s*(.+)/i
    ];
    
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
            const title = match[1] || 'Document';
            const content = match[2] || match[0];
            return { title, content: content.trim() };
        }
    }
    return null;
}

// ========== PROCESS MESSAGES ==========
client.on('message', async (message) => {
    if (!botActive || message.from === 'status@broadcast') return;
    
    const body = message.body.trim();
    const lowerBody = body.toLowerCase();
    const isMentioned = message.mentionedIds?.includes(client.info.wid._serialized) || false;
    const isGroup = message.from.includes('@g.us');
    const sender = message.author || message.from;
    const prefixLower = BOT_PREFIX.toLowerCase();

    // Check if it's a command
    const isCommand = lowerBody.startsWith(prefixLower) || 
                      (isGroup && isMentioned && lowerBody.includes(prefixLower));

    // ========== PROCESS COMMANDS ==========
    if (isCommand) {
        let command = '';
        let args = '';
        
        if (lowerBody.startsWith(prefixLower)) {
            const parts = lowerBody.slice(prefixLower.length).trim().split(' ');
            command = parts[0] || '';
            args = parts.slice(1).join(' ');
        } else if (isMentioned) {
            const parts = lowerBody.split(prefixLower);
            if (parts.length > 1) {
                const rest = parts[1].trim().split(' ');
                command = rest[0] || '';
                args = rest.slice(1).join(' ');
            }
        }

        // ========== ONLY TWO COMMANDS: ACTIVATE & DEACTIVATE ==========
        switch (command) {
            case 'activate':
            case 'on':
                if (isGroup) {
                    await message.reply('✅ AI activated in this group! Just talk to me naturally.');
                    activeUsers.add(sender);
                } else {
                    await message.reply('✅ AI activated! Just talk to me naturally.');
                    activeUsers.add(sender);
                }
                console.log(`✅ AI activated for user: ${sender}`);
                break;

            case 'deactivate':
            case 'off':
                activeUsers.delete(sender);
                conversationHistory.delete(sender);
                await message.reply('⛔ AI deactivated. Send ".@banana code helper activate" to reactivate.');
                console.log(`⛔ AI deactivated for user: ${sender}`);
                break;

            default:
                // If user sends unknown command but is active, respond as AI
                if (activeUsers.has(sender)) {
                    const response = await askAI(body);
                    await message.reply(response);
                } else {
                    await message.reply(`❌ Unknown command. Only \`activate\` and \`deactivate\` are available.\n\n💡 Or just talk to me naturally! Say "hola" and I'll respond.`);
                }
        }
        return;
    }

    // ========== NATURAL CONVERSATION ==========
    // Check if should respond
    const autoActivate = AUTO_ACTIVATE_ON_GREETING === 'true';
    const shouldRespond = activeUsers.has(sender) || 
                         (autoActivate && isGreeting(body));

    if (shouldRespond) {
        // Check for special actions in the message
        let response = null;
        
        // Check if user wants to generate an image
        const imagePrompt = extractImageRequest(body);
        if (imagePrompt) {
            await message.reply('🎨 Generating image... please wait.');
            const imageUrl = await generateImage(imagePrompt);
            if (imageUrl) {
                try {
                    const media = await MessageMedia.fromUrl(imageUrl);
                    await client.sendMessage(message.from, media, { 
                        caption: `🖼️ Image generated for: "${imagePrompt}"\n🔗 ${imageUrl}` 
                    });
                    console.log(`🖼️ Image generated for: ${sender}`);
                    return;
                } catch (error) {
                    await message.reply(`❌ Error sending image. URL: ${imageUrl}`);
                    return;
                }
            } else {
                await message.reply('❌ Could not generate image. Try a different prompt.');
                return;
            }
        }
        
        // Check if user wants to create a file
        const fileRequest = extractFileRequest(body);
        if (fileRequest) {
            const { filename, content } = fileRequest;
            const filePath = saveFile(content, filename);
            if (filePath) {
                const pastefyUrl = await uploadToPastefy(content, filename);
                await message.reply(`✅ File created: ${filename}\n📁 Path: ${filePath}\n🔗 ${pastefyUrl || 'Could not upload to Pastefy'}`);
                console.log(`📁 File created: ${filename} for ${sender}`);
                return;
            } else {
                await message.reply('❌ Error creating the file.');
                return;
            }
        }
        
        // Check if user wants to upload to Pastefy
        const pastefyRequest = extractPastefyRequest(body);
        if (pastefyRequest && PASTEFY_API_KEY) {
            const { title, content } = pastefyRequest;
            await message.reply('📤 Uploading to Pastefy...');
            const pastefyUrl = await uploadToPastefy(content, title);
            if (pastefyUrl) {
                await message.reply(`✅ Uploaded to Pastefy!\n📝 Title: ${title}\n🔗 ${pastefyUrl}`);
                console.log(`📤 Uploaded to Pastefy: ${title} for ${sender}`);
                return;
            } else {
                await message.reply('❌ Error uploading to Pastefy.');
                return;
            }
        }
        
        // If no special action, just respond with AI
        let history = conversationHistory.get(sender) || [];
        if (history.length > parseInt(MAX_HISTORY) * 2) {
            history = history.slice(-parseInt(MAX_HISTORY) * 2);
        }
        
        response = await askAI(body, history);
        
        // Update history
        history.push({ role: "user", content: body });
        history.push({ role: "assistant", content: response });
        conversationHistory.set(sender, history);
        
        await message.reply(response);
        console.log(`💬 AI responded to: ${sender}`);
        
        // Auto-activate on greeting
        if (!activeUsers.has(sender) && isGreeting(body) && autoActivate) {
            activeUsers.add(sender);
            await message.reply('👋 I\'ve activated AI for you! You can now talk to me anytime.');
            console.log(`✅ Auto-activated for: ${sender}`);
        }
    }
});

// ========== START BOT ==========
client.initialize();

// ========== ERROR HANDLING ==========
client.on('disconnected', (reason) => {
    console.log('⚠️ Bot disconnected:', reason);
    botActive = false;
    console.log('🔄 Attempting to reconnect...');
    setTimeout(() => {
        client.initialize();
    }, 5000);
});

client.on('auth_failure', (error) => {
    console.error('❌ Authentication failed:', error);
    botActive = false;
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled error:', error);
});

process.on('SIGINT', () => {
    console.log('\n👋 Shutting down bot...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n👋 Shutting down bot...');
    client.destroy();
    process.exit(0);
});

console.log('🚀 WhatsApp AI Bot started successfully!');
console.log('📱 Waiting for QR code...');
