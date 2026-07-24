require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { OpenAI } = require('openai');

// ========== LOAD ENVIRONMENT VARIABLES ==========
const {
    DISCORD_TOKEN,
    DISCORD_CLIENT_ID,
    OPENAI_API_KEY,
    PASTEFY_API_KEY,
    AI_MODEL = 'gpt-4',
    AI_TEMPERATURE = 0.8,
    AI_MAX_TOKENS = 1000,
    IMAGE_SIZE = '1024x1024',
    IMAGE_MODEL = 'dall-e-3',
    MAX_HISTORY = 10
} = process.env;

// ========== VALIDATE CONFIGURATION ==========
if (!DISCORD_TOKEN) {
    console.error('❌ DISCORD_TOKEN is required! Set it in Railway environment variables');
    process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
    console.error('❌ DISCORD_CLIENT_ID is required! Set it in Railway environment variables');
    process.exit(1);
}

if (!OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is required! Set it in Railway environment variables');
    process.exit(1);
}

console.log('🚀 Starting Discord AI Bot on Railway...');
console.log(`🤖 AI Model: ${AI_MODEL}`);
console.log(`📊 Client ID: ${DISCORD_CLIENT_ID}`);

// ========== INITIALIZE DISCORD CLIENT ==========
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages
    ],
    partials: [
        Partials.Channel,
        Partials.Message
    ]
});

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ========== GLOBAL VARIABLES ==========
const activeUsers = new Set();
const conversationHistory = new Map();
const tempPath = path.join(__dirname, 'temp');

// ========== ENSURE TEMP FOLDER EXISTS ==========
if (!fs.existsSync(tempPath)) {
    fs.mkdirSync(tempPath, { recursive: true });
    console.log(`📁 Created temp folder: ${tempPath}`);
}

// ========== HELPER FUNCTIONS ==========

async function uploadToPastefy(text, title = 'Document') {
    if (!PASTEFY_API_KEY) {
        return null;
    }
    
    try {
        const response = await axios.post('https://pastefy.app/api/v2/pastes', {
            content: text,
            title: title,
            encrypted: false
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

async function askAI(question, context = [], username = 'User') {
    try {
        const messages = [
            { 
                role: "system", 
                content: `You are a helpful and friendly Discord bot assistant. Respond naturally. Be conversational.
                         User: ${username}
                         Date: ${new Date().toLocaleDateString()}`
            }
        ];
        
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

function createEmbed(title, description, color = '#5865F2', fields = []) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setTimestamp()
        .setFooter({ text: '🤖 AI Bot', iconURL: client.user?.displayAvatarURL() });

    if (fields.length > 0) {
        embed.addFields(fields);
    }

    return embed;
}

// ========== REGISTER SLASH COMMANDS ==========
async function registerCommands() {
    const commands = [
        {
            name: 'activate',
            description: 'Activate AI in this channel'
        },
        {
            name: 'deactivate',
            description: 'Deactivate AI in this channel'
        },
        {
            name: 'image',
            description: 'Generate an image with AI',
            options: [
                {
                    name: 'prompt',
                    description: 'Describe the image you want',
                    type: 3,
                    required: true
                }
            ]
        },
        {
            name: 'pastefy',
            description: 'Upload text to Pastefy',
            options: [
                {
                    name: 'content',
                    description: 'Content to upload',
                    type: 3,
                    required: true
                },
                {
                    name: 'title',
                    description: 'Title for the paste',
                    type: 3,
                    required: false
                }
            ]
        },
        {
            name: 'file',
            description: 'Create a file',
            options: [
                {
                    name: 'filename',
                    description: 'File name with extension',
                    type: 3,
                    required: true
                },
                {
                    name: 'content',
                    description: 'File content',
                    type: 3,
                    required: true
                }
            ]
        },
        {
            name: 'help',
            description: 'Show all available commands'
        },
        {
            name: 'clear',
            description: 'Clear conversation history'
        },
        {
            name: 'info',
            description: 'Show bot information'
        }
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
        
        console.log('🔄 Registering slash commands...');
        
        await rest.put(
            Routes.applicationCommands(DISCORD_CLIENT_ID),
            { body: commands }
        );
        
        console.log(`✅ Registered ${commands.length} slash commands globally`);
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
}

// ========== DISCORD EVENTS ==========

client.once('ready', async () => {
    console.log(`✅ Bot connected as ${client.user.tag}`);
    console.log(`📊 Serving ${client.guilds.cache.size} servers`);
    console.log(`🤖 AI Model: ${AI_MODEL}`);
    
    await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, user } = interaction;
    const userId = user.id;
    const userName = user.username;

    switch (commandName) {
        case 'activate': {
            activeUsers.add(userId);
            
            const embed = createEmbed(
                '✅ AI Activated!',
                'AI is now active for you. Just send me messages and I\'ll respond!',
                '#00FF00'
            );
            
            await interaction.reply({ embeds: [embed] });
            break;
        }

        case 'deactivate': {
            activeUsers.delete(userId);
            conversationHistory.delete(userId);
            
            const embed = createEmbed(
                '⛔ AI Deactivated',
                'AI has been deactivated. Use `/activate` to reactivate.',
                '#FF0000'
            );
            
            await interaction.reply({ embeds: [embed] });
            break;
        }

        case 'image': {
            const prompt = interaction.options.getString('prompt');
            
            await interaction.reply('🎨 Generating image... please wait.');
            
            const imageUrl = await generateImage(prompt);
            
            if (imageUrl) {
                const embed = createEmbed(
                    '🖼️ Image Generated',
                    `Prompt: **${prompt}**`,
                    '#FF6B6B',
                    [{ name: '🔗 URL', value: `[Click here](${imageUrl})` }]
                );
                
                await interaction.editReply({
                    content: null,
                    embeds: [embed],
                    files: [imageUrl]
                });
            } else {
                await interaction.editReply('❌ Could not generate image. Try a different prompt.');
            }
            break;
        }

        case 'pastefy': {
            const content = interaction.options.getString('content');
            const title = interaction.options.getString('title') || `Document ${Date.now()}`;
            
            if (!PASTEFY_API_KEY) {
                await interaction.reply('❌ Pastefy is not configured. Please set PASTEFY_API_KEY in Railway variables.');
                return;
            }
            
            await interaction.reply('📤 Uploading to Pastefy...');
            
            const pastefyUrl = await uploadToPastefy(content, title);
            
            if (pastefyUrl) {
                const embed = createEmbed(
                    '✅ Uploaded to Pastefy!',
                    `Title: **${title}**`,
                    '#00FF00',
                    [{ name: '🔗 Link', value: pastefyUrl }]
                );
                await interaction.editReply({ content: null, embeds: [embed] });
            } else {
                await interaction.editReply('❌ Error uploading to Pastefy.');
            }
            break;
        }

        case 'file': {
            const filename = interaction.options.getString('filename');
            const content = interaction.options.getString('content');
            
            await interaction.reply('📁 Creating file...');
            
            const filePath = saveFile(content, filename);
            
            if (filePath) {
                const embed = createEmbed(
                    '✅ File Created!',
                    `File: **${filename}**`,
                    '#00FF00'
                );
                
                await interaction.editReply({
                    content: null,
                    embeds: [embed],
                    files: [filePath]
                });
                
                setTimeout(() => {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (error) {}
                }, 5000);
            } else {
                await interaction.editReply('❌ Error creating the file.');
            }
            break;
        }

        case 'help': {
            const embed = createEmbed(
                '🤖 Available Commands',
                'Here are all the commands you can use:',
                '#5865F2',
                [
                    { name: '🟢 `/activate`', value: 'Activate AI in this channel', inline: true },
                    { name: '🔴 `/deactivate`', value: 'Deactivate AI', inline: true },
                    { name: '🖼️ `/image [prompt]`', value: 'Generate an image', inline: true },
                    { name: '📤 `/pastefy [content]`', value: 'Upload text to Pastefy', inline: true },
                    { name: '📁 `/file [filename] [content]`', value: 'Create a file', inline: true },
                    { name: '💬 `/clear`', value: 'Clear conversation history', inline: true },
                    { name: 'ℹ️ `/info`', value: 'Show bot information', inline: true },
                    { name: '💡 **Normal Chat**', value: 'Just send any message and I\'ll respond!', inline: false }
                ]
            );
            
            await interaction.reply({ embeds: [embed] });
            break;
        }

        case 'clear': {
            conversationHistory.delete(userId);
            const embed = createEmbed(
                '🧹 History Cleared',
                'Your conversation history has been cleared.',
                '#FFA500'
            );
            await interaction.reply({ embeds: [embed] });
            break;
        }

        case 'info': {
            const embed = createEmbed(
                'ℹ️ Bot Information',
                'AI-powered Discord bot with multiple features',
                '#5865F2',
                [
                    { name: '🤖 AI Model', value: AI_MODEL, inline: true },
                    { name: '🖼️ Image Model', value: IMAGE_MODEL, inline: true },
                    { name: '📊 Servers', value: `${client.guilds.cache.size}`, inline: true },
                    { name: '💬 Max History', value: `${MAX_HISTORY} messages`, inline: true },
                    { name: '📁 Temp Files', value: fs.readdirSync(tempPath).length, inline: true }
                ]
            );
            await interaction.reply({ embeds: [embed] });
            break;
        }
    }
});

// ========== PROCESS NORMAL MESSAGES ==========
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;

    const content = message.content.trim();
    const userId = message.author.id;
    const userName = message.author.username;

    // Check if user is active or mentioned
    const shouldRespond = activeUsers.has(userId) || 
                         content.toLowerCase().includes('hola') ||
                         content.toLowerCase().includes('hello') ||
                         content.toLowerCase().includes('hi') ||
                         message.mentions.has(client.user);

    if (shouldRespond) {
        let history = conversationHistory.get(userId) || [];
        if (history.length > parseInt(MAX_HISTORY) * 2) {
            history = history.slice(-parseInt(MAX_HISTORY) * 2);
        }
        
        const response = await askAI(content, history, userName);
        
        history.push({ role: "user", content: content });
        history.push({ role: "assistant", content: response });
        conversationHistory.set(userId, history);
        
        await message.reply(response);
        
        // Auto-activate on greeting
        if (!activeUsers.has(userId) && 
            (content.toLowerCase().includes('hola') || 
             content.toLowerCase().includes('hello') || 
             content.toLowerCase().includes('hi'))) {
            activeUsers.add(userId);
            await message.reply('👋 I\'ve activated AI for you! You can now talk to me anytime.');
        }
    }
});

// ========== START BOT ==========
client.login(DISCORD_TOKEN);

// ========== ERROR HANDLING ==========
client.on('disconnected', () => {
    console.log('⚠️ Bot disconnected');
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

console.log('🚀 Discord AI Bot started successfully!');
