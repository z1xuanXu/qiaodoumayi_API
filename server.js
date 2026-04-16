const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const _ = require('lodash');
const readline = require('readline/promises');
const multer = require('multer');

const app = express();

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024
    }
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ======== 本地图床初始化 ========
const outputDir = path.join(process.cwd(), 'outputs');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
app.use('/outputs', express.static(outputDir));
// ================================

const configPath = path.join(process.cwd(), 'config.json');

let config = {
    port: 5000,
    activePreset: null,
    presets: {}
};

// ================= 模型比例 / 分辨率规则 =================

const BASIC_RATIOS = [
    '1:1',
    '16:9',
    '9:16',
    '4:3',
    '3:4',
    '21:9',
    '3:2',
    '2:3'
];

const BANANA2_EXTRA_RATIOS = [
    '1:4',
    '4:1',
    '1:8',
    '8:1',
    '4:5',
    '5:4'
];

const BANANA2_RATIOS = [
    ...BASIC_RATIOS,
    ...BANANA2_EXTRA_RATIOS
];

const ALLOWED_RESOLUTIONS = ['1k', '2k', '4k'];

const RESOLUTION_LONG_SIDE = {
    '1k': 1024,
    '2k': 2048,
    '4k': 4096
};

const BANNER = `
\x1b[36m
 ███████╗██╗██╗  ██╗██╗   ██╗ █████╗ ███╗   ██╗
 ╚══███╔╝██║╚██╗██╔╝██║   ██║██╔══██╗████╗  ██║
   ███╔╝ ██║ ╚███╔╝ ██║   ██║███████║██╔██╗ ██║
  ███╔╝  ██║ ██╔██╗ ██║   ██║██╔══██║██║╚██╗██║
 ███████╗██║██╔╝ ██╗╚██████╔╝██║  ██║██║ ╚████║
 ╚══════╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝
\x1b[0m
*************************************************
* 子 轩  A P I   网 关 系 统  v4                 *
*************************************************
`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function saveConfig() {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
}

function loadConfig() {
    if (!fs.existsSync(configPath)) return;

    try {
        const loadedData = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        config = {
            ...config,
            ...loadedData
        };

        if (!config.presets) config.presets = {};
    } catch (e) {
        console.log('⚠️ config.json 格式错误，暂时使用默认配置。请检查 config.json。');
    }
}

function logSafe(msg, data) {
    if (data === undefined || data === null) {
        console.log(`\x1b[36m${msg}\x1b[0m`);
        return;
    }

    let dataStr = typeof data === 'string' ? data : JSON.stringify(data);

    if (dataStr.length > 300) {
        console.log(`\x1b[36m${msg}\x1b[0m \x1b[33m${dataStr.substring(0, 300)}... [内容过长已折叠]\x1b[0m`);
    } else {
        console.log(`\x1b[36m${msg}\x1b[0m \x1b[32m${dataStr}\x1b[0m`);
    }
}

function safeJsonParse(value, fallback = value) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

// ================= 防走死输入工具 =================

function normalizeCmd(input) {
    return String(input || '').trim().toLowerCase();
}

function isBack(input) {
    const s = normalizeCmd(input);
    return s === 'b' || s === 'back' || s === '返回' || s === '上一步';
}

function isExit(input) {
    const s = normalizeCmd(input);
    return s === 'exit' || s === 'quit' || s === 'q' || s === '放弃' || s === '退出';
}

async function waitEnter(rl, text = '\n按回车继续...') {
    await rl.question(text);
}

async function askInput(rl, question, options = {}) {
    const {
        allowEmpty = true,
        allowBack = true,
        allowExit = true,
        defaultValue = undefined
    } = options;

    while (true) {
        const suffix = [];
        if (allowBack) suffix.push('b=上一步');
        if (allowExit) suffix.push('exit=放弃');
        if (defaultValue !== undefined) suffix.push(`默认=${defaultValue}`);

        const prompt = suffix.length > 0 ? `${question} (${suffix.join(', ')}): ` : `${question}: `;
        const raw = await rl.question(prompt);
        const value = raw.trim();

        if (allowBack && isBack(value)) {
            return { type: 'back' };
        }

        if (allowExit && isExit(value)) {
            return { type: 'exit' };
        }

        if (!value && defaultValue !== undefined) {
            return { type: 'value', value: defaultValue };
        }

        if (!allowEmpty && !value) {
            console.log('\x1b[31m❌ 这里不能为空，请重新输入。\x1b[0m');
            continue;
        }

        return { type: 'value', value: raw };
    }
}

async function askJson(rl, question, options = {}) {
    const {
        allowEmpty = true,
        defaultValue = undefined,
        example = ''
    } = options;

    while (true) {
        if (example) {
            console.log(`\x1b[33m示例：${example}\x1b[0m`);
        }

        const result = await askInput(rl, question, {
            allowEmpty,
            allowBack: true,
            allowExit: true,
            defaultValue: undefined
        });

        if (result.type !== 'value') return result;

        const raw = result.value.trim();

        if (!raw && allowEmpty) {
            return { type: 'value', value: defaultValue };
        }

        try {
            const parsed = JSON.parse(raw);
            return { type: 'value', value: parsed };
        } catch (e) {
            console.log('\x1b[31m❌ JSON 格式错误，不要带说明文字，只粘贴纯 JSON。\x1b[0m');
            console.log(`错误原因：${e.message}`);
            console.log('请重新输入，或者输入 b 返回上一步，exit 放弃。');
        }
    }
}

async function askMenuChoice(rl, validChoices) {
    const valid = validChoices.map(v => String(v).toLowerCase());

    while (true) {
        const choice = (await rl.question('请输入选项: ')).trim();

        if (valid.includes(choice.toLowerCase())) {
            return choice;
        }

        console.log('\x1b[31m❌ 输入无效，请重新输入菜单里的选项。\x1b[0m');
        await sleep(700);
    }
}

// ================= 多任务管理 =================

const tasks = new Map();

function createTask(info) {
    const id = `task_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;

    const task = {
        id,
        status: 'running',
        progress: 1,
        stage: '已接收任务',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        finishedAt: null,

        mode: info.mode || 'unknown',
        rawModel: info.rawModel || '',
        mappedModel: info.mappedModel || '',
        modelFamily: info.modelFamily || '',
        prompt: String(info.prompt || '').slice(0, 120),
        aspectRatio: info.aspectRatio || '',
        resolution: info.resolution || '',
        size: info.size || '',
        width: info.width || '',
        height: info.height || '',
        imageCount: info.imageCount || 0,
        providerUrl: info.providerUrl || '',
        error: null,
        outputUrls: []
    };

    tasks.set(id, task);
    pruneTasks();

    console.log(renderTaskLine(task));

    return task;
}

function pruneTasks() {
    const all = Array.from(tasks.values());

    if (all.length <= 100) return;

    const finished = all
        .filter(t => t.status === 'completed' || t.status === 'failed')
        .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));

    while (tasks.size > 100 && finished.length > 0) {
        const t = finished.shift();
        tasks.delete(t.id);
    }
}

function updateTask(task, patch = {}) {
    if (!task) return;

    Object.assign(task, patch);
    task.updatedAt = new Date().toISOString();

    if (task.progress > 100) task.progress = 100;
    if (task.progress < 0) task.progress = 0;

    tasks.set(task.id, task);

    console.log(renderTaskLine(task));
}

function finishTask(task, urls = []) {
    updateTask(task, {
        status: 'completed',
        progress: 100,
        stage: '任务完成',
        finishedAt: new Date().toISOString(),
        outputUrls: urls
    });
}

function failTask(task, error) {
    updateTask(task, {
        status: 'failed',
        progress: 100,
        stage: '任务失败',
        finishedAt: new Date().toISOString(),
        error: typeof error === 'string' ? error : JSON.stringify(error).slice(0, 800)
    });
}

function makeProgressBar(progress, width = 20) {
    const done = Math.round((progress / 100) * width);
    const empty = width - done;
    return `[${'█'.repeat(done)}${'░'.repeat(empty)}] ${String(progress).padStart(3, ' ')}%`;
}

function renderTaskLine(task) {
    const color =
        task.status === 'completed' ? '\x1b[32m' :
        task.status === 'failed' ? '\x1b[31m' :
        '\x1b[36m';

    return `${color}${makeProgressBar(task.progress)} ${task.status.toUpperCase()} ${task.id}\x1b[0m | ${task.stage} | ${task.rawModel} -> ${task.mappedModel} | ${task.aspectRatio} ${task.resolution} ${task.size}`;
}

function printTaskList() {
    const list = Array.from(tasks.values())
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    console.log('\n================= 当前任务列表 =================');

    if (list.length === 0) {
        console.log('暂无任务。');
        console.log('================================================\n');
        return;
    }

    for (const task of list.slice(0, 30)) {
        console.log(renderTaskLine(task));

        if (task.outputUrls && task.outputUrls.length > 0) {
            console.log(`  输出: ${task.outputUrls.join(' | ')}`);
        }

        if (task.error) {
            console.log(`  错误: ${task.error}`);
        }
    }

    console.log('================================================\n');
}

// ================= 比例 / 分辨率解析 =================

function detectModelFamily(rawModel = '', mappedModel = '') {
    const text = `${rawModel} ${mappedModel}`
        .toLowerCase()
        .replace(/[\s_\-]/g, '');

    if (
        text.includes('banana2') ||
        text.includes('nanobanana2') ||
        text.includes('banana02') ||
        text.includes('nanobanana02') ||
        text.includes('gemini31flash')
    ) {
        return 'banana2';
    }

    if (
        text.includes('bananapro') ||
        text.includes('nanobananapro') ||
        text.includes('pro')
    ) {
        return 'pro';
    }

    return 'banana';
}

function normalizeColonRatio(value) {
    if (!value) return '';

    let s = String(value)
        .trim()
        .toLowerCase()
        .replace('：', ':')
        .replace(/\s+/g, '');

    if (s.includes('x') && /^\d+x\d+$/.test(s)) {
        const [w, h] = s.split('x').map(Number);
        return simplifyRatio(w, h);
    }

    if (/^\d+:\d+$/.test(s)) {
        const [w, h] = s.split(':').map(Number);
        return `${w}:${h}`;
    }

    return '';
}

function simplifyRatio(w, h) {
    if (!w || !h) return '';

    const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
    const g = gcd(w, h);

    const rw = Math.round(w / g);
    const rh = Math.round(h / g);

    const simplified = `${rw}:${rh}`;

    if (BANANA2_RATIOS.includes(simplified)) return simplified;

    const decimal = w / h;

    const candidates = BANANA2_RATIOS.map(r => {
        const [a, b] = r.split(':').map(Number);
        return {
            ratio: r,
            diff: Math.abs(decimal - a / b)
        };
    }).sort((a, b) => a.diff - b.diff);

    if (candidates[0] && candidates[0].diff < 0.04) {
        return candidates[0].ratio;
    }

    return simplified;
}

function inferRatioFromBody(body = {}) {
    const direct = body.aspect_ratio ||
        body.aspectRatio ||
        body.ratio ||
        body.output_aspect_ratio ||
        body.image_aspect_ratio;

    const directRatio = normalizeColonRatio(direct);
    if (directRatio) return directRatio;

    const size = body.size || body.image_size || body.imageSize || body.dimensions;

    if (size) {
        const sizeStr = String(size).trim();

        const ratioFromSize = normalizeColonRatio(sizeStr);
        if (ratioFromSize) return ratioFromSize;

        if (/^\d+\s*[xX]\s*\d+$/.test(sizeStr)) {
            const [w, h] = sizeStr.toLowerCase().split('x').map(v => parseInt(v.trim(), 10));
            return simplifyRatio(w, h);
        }
    }

    return '1:1';
}

function normalizeResolution(value) {
    if (!value) return '';

    let s = String(value).trim().toLowerCase().replace(/\s+/g, '');

    if (s === '1k' || s === '1K'.toLowerCase() || s === '1024' || s === '1024px') return '1k';
    if (s === '2k' || s === '2K'.toLowerCase() || s === '2048' || s === '2048px') return '2k';
    if (s === '4k' || s === '4K'.toLowerCase() || s === '4096' || s === '4096px') return '4k';

    if (/^\d+x\d+$/.test(s)) {
        const [w, h] = s.split('x').map(Number);
        const longSide = Math.max(w, h);

        if (longSide <= 1400) return '1k';
        if (longSide <= 2800) return '2k';
        return '4k';
    }

    if (s.includes('1k')) return '1k';
    if (s.includes('2k')) return '2k';
    if (s.includes('4k')) return '4k';

    return '';
}

function inferResolutionFromBody(body = {}) {
    const direct = body.resolution ||
        body.quality ||
        body.output_resolution ||
        body.image_resolution ||
        body.imageResolution ||
        body.imageSize ||
        body.image_size;

    const directResolution = normalizeResolution(direct);
    if (directResolution) return directResolution;

    const size = body.size || body.dimensions;
    const fromSize = normalizeResolution(size);
    if (fromSize) return fromSize;

    return '1k';
}

function normalizeResolutionForProvider(resolution) {
    const r = normalizeResolution(resolution);
    if (r === '1k') return '1K';
    if (r === '2k') return '2K';
    if (r === '4k') return '4K';
    return '1K';
}

function roundToMultiple(value, multiple = 8) {
    return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function dimensionsFromRatioAndResolution(aspectRatio, resolution) {
    const [rw, rh] = aspectRatio.split(':').map(Number);
    const longSide = RESOLUTION_LONG_SIDE[resolution] || 1024;

    let width;
    let height;

    if (rw >= rh) {
        width = longSide;
        height = longSide * (rh / rw);
    } else {
        height = longSide;
        width = longSide * (rw / rh);
    }

    return {
        width: roundToMultiple(width),
        height: roundToMultiple(height)
    };
}

function validateImageOptions(rawModel, mappedModel, body = {}) {
    const modelFamily = detectModelFamily(rawModel, mappedModel);
    const aspectRatio = inferRatioFromBody(body);
    const resolution = inferResolutionFromBody(body);

    const allowedRatios = modelFamily === 'banana2'
        ? BANANA2_RATIOS
        : BASIC_RATIOS;

    if (!allowedRatios.includes(aspectRatio)) {
        throw new Error(
            `当前模型 [${rawModel}] 属于 ${modelFamily}，不支持比例 ${aspectRatio}。` +
            `允许比例：${allowedRatios.join(', ')}`
        );
    }

    if (!ALLOWED_RESOLUTIONS.includes(resolution)) {
        throw new Error(
            `不支持分辨率 ${resolution}。所有 banana 模型只允许：${ALLOWED_RESOLUTIONS.join(', ')}`
        );
    }

    const { width, height } = dimensionsFromRatioAndResolution(aspectRatio, resolution);

    return {
        modelFamily,
        aspectRatio,
        resolution,
        providerResolution: normalizeResolutionForProvider(resolution),
        width,
        height,
        size: `${width}x${height}`,
        allowedRatios
    };
}

// ================= 模板编译系统 =================

function compileStringTemplate(str, variables) {
    if (typeof str !== 'string') return str;

    const exactMatch = str.match(/^{{\s*([\w.]+)\s*}}$/);

    if (exactMatch) {
        const value = _.get(variables, exactMatch[1]);
        return value === undefined ? str : value;
    }

    return str.replace(/{{\s*([\w.]+)\s*}}/g, (match, key) => {
        const value = _.get(variables, key);

        if (value === undefined || value === null) return '';

        if (typeof value === 'object') {
            return JSON.stringify(value);
        }

        return String(value);
    });
}

function compileTemplate(node, variables) {
    if (node === null || node === undefined) return node;

    if (typeof node === 'string') {
        return compileStringTemplate(node, variables);
    }

    if (Array.isArray(node)) {
        return node.map(item => compileTemplate(item, variables));
    }

    if (typeof node === 'object') {
        const out = {};

        for (const [key, value] of Object.entries(node)) {
            out[key] = compileTemplate(value, variables);
        }

        return out;
    }

    return node;
}

// ================= OpenAI 请求解析 =================

function normalizeOpenAiContent(content) {
    if (!content) return '';

    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map(item => {
            if (typeof item === 'string') return item;
            if (item.type === 'text') return item.text || '';
            if (item.text) return item.text;
            return '';
        }).filter(Boolean).join('\n');
    }

    return '';
}

function extractPrompt(body = {}) {
    if (body.prompt) return String(body.prompt);

    if (body.input) {
        return typeof body.input === 'string' ? body.input : JSON.stringify(body.input);
    }

    if (Array.isArray(body.messages)) {
        const lastUser = [...body.messages].reverse().find(m => m.role === 'user') || body.messages[body.messages.length - 1];
        return normalizeOpenAiContent(lastUser?.content);
    }

    return '';
}

function guessMimeFromBase64(base64) {
    const head = String(base64 || '').slice(0, 30);

    if (head.startsWith('/9j/')) return 'image/jpeg';
    if (head.startsWith('iVBOR')) return 'image/png';
    if (head.startsWith('UklGR')) return 'image/webp';
    if (head.startsWith('R0lGOD')) return 'image/gif';

    return 'image/png';
}

function extFromMime(mimeType = 'image/png') {
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('gif')) return 'gif';
    return 'png';
}

function parseDataUrl(value) {
    if (typeof value !== 'string') return null;

    const match = value.match(/^data:(image\/[\w.+-]+);base64,(.+)$/s);

    if (!match) return null;

    return {
        mimeType: match[1],
        base64: match[2].replace(/[\r\n\s]/g, '')
    };
}

function cleanRawBase64(value) {
    if (typeof value !== 'string') return null;

    const cleaned = value
        .replace(/^data:image\/[^;]+;base64,/i, '')
        .replace(/[\r\n\s]/g, '')
        .trim();

    if (cleaned.length < 100) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) return null;

    return cleaned;
}

async function imageStringToBase64(value, fallbackMime = 'image/png') {
    if (!value || typeof value !== 'string') return null;

    const parsedDataUrl = parseDataUrl(value);

    if (parsedDataUrl) {
        return parsedDataUrl;
    }

    if (/^https?:\/\//i.test(value)) {
        logSafe('[图生图] 正在下载远程参考图:', value);

        const response = await axios.get(value, {
            responseType: 'arraybuffer',
            timeout: 60000,
            maxContentLength: 100 * 1024 * 1024
        });

        const mimeType = response.headers['content-type']?.split(';')[0] || fallbackMime;

        return {
            mimeType,
            base64: Buffer.from(response.data).toString('base64')
        };
    }

    const rawBase64 = cleanRawBase64(value);

    if (rawBase64) {
        return {
            mimeType: fallbackMime || guessMimeFromBase64(rawBase64),
            base64: rawBase64
        };
    }

    return null;
}

function extractImagesFromMessages(body = {}) {
    const found = [];

    if (!Array.isArray(body.messages)) return found;

    for (const msg of body.messages) {
        const content = msg?.content;

        if (!Array.isArray(content)) continue;

        for (const item of content) {
            if (!item || typeof item !== 'object') continue;

            if (item.type === 'image_url' && item.image_url) {
                found.push(typeof item.image_url === 'string' ? item.image_url : item.image_url.url);
            }

            if (item.type === 'input_image' && item.image_url) {
                found.push(item.image_url);
            }

            if (item.type === 'input_image' && item.image_data) {
                found.push(item.image_data);
            }

            if (item.inline_data?.data) {
                found.push(`data:${item.inline_data.mime_type || 'image/png'};base64,${item.inline_data.data}`);
            }

            if (item.inlineData?.data) {
                found.push(`data:${item.inlineData.mimeType || 'image/png'};base64,${item.inlineData.data}`);
            }
        }
    }

    return found.filter(Boolean);
}

async function collectInputImages(req, task = null) {
    const images = [];

    if (Array.isArray(req.files)) {
        for (const file of req.files) {
            if (!file || !file.buffer) continue;

            if (
                file.fieldname === 'image' ||
                file.fieldname === 'images' ||
                file.fieldname.startsWith('image')
            ) {
                images.push({
                    mimeType: file.mimetype || 'image/png',
                    base64: file.buffer.toString('base64'),
                    source: `multipart:${file.fieldname}`
                });
            }
        }
    }

    const body = req.body || {};
    const candidates = [];

    for (const key of [
        'image',
        'images',
        'input_image',
        'input_images',
        'image_url',
        'image_urls',
        'reference_image',
        'reference_images'
    ]) {
        if (body[key] !== undefined) {
            const parsed = safeJsonParse(body[key]);

            if (Array.isArray(parsed)) {
                candidates.push(...parsed);
            } else {
                candidates.push(parsed);
            }
        }
    }

    candidates.push(...extractImagesFromMessages(body));

    let index = 0;

    for (const item of candidates) {
        index++;

        if (!item) continue;

        if (task) {
            updateTask(task, {
                progress: Math.min(24, 10 + index * 2),
                stage: `解析参考图 ${index}`
            });
        }

        let value = item;
        let mimeType = 'image/png';

        if (typeof item === 'object') {
            if (item.url) {
                value = item.url;
            } else if (item.image_url) {
                value = typeof item.image_url === 'string' ? item.image_url : item.image_url.url;
            } else if (item.b64_json) {
                value = item.b64_json;
            } else if (item.base64) {
                value = item.base64;
            } else if (item.data) {
                value = item.data;
            }

            mimeType = item.mime_type || item.mimeType || mimeType;
        }

        const parsed = await imageStringToBase64(value, mimeType);

        if (parsed) {
            images.push({
                ...parsed,
                source: 'body'
            });
        }
    }

    return images;
}

// ================= 服务商变量构造 =================

function buildVariables({ prompt, rawModel, mappedModel, apiKey, images, imageOptions }) {
    const first = images[0] || {
        mimeType: 'image/png',
        base64: ''
    };

    const dataUrls = images.map(img => `data:${img.mimeType};base64,${img.base64}`);

    const geminiInlineParts = images.map(img => ({
        inline_data: {
            mime_type: img.mimeType,
            data: img.base64
        }
    }));

    return {
        prompt,
        model: mappedModel,
        rawModel,
        apiKey,

        aspect_ratio: imageOptions.aspectRatio,
        aspectRatio: imageOptions.aspectRatio,
        ratio: imageOptions.aspectRatio,

        resolution: imageOptions.resolution,
        providerResolution: imageOptions.providerResolution,
        imageSize: imageOptions.providerResolution,
        quality: imageOptions.resolution,

        size: imageOptions.size,
        image_size: imageOptions.size,

        width: imageOptions.width,
        height: imageOptions.height,

        modelFamily: imageOptions.modelFamily,

        imageBase64: first.base64,
        imageMimeType: first.mimeType,
        imageDataUrl: first.base64 ? `data:${first.mimeType};base64,${first.base64}` : '',

        imagesBase64: images.map(img => img.base64),
        imagesMimeTypes: images.map(img => img.mimeType),
        imagesDataUrls: dataUrls,

        geminiInlineParts,

        geminiParts: [
            {
                text: prompt || 'Edit this image.'
            },
            ...geminiInlineParts
        ],

        openAiImages: images.map(img => ({
            type: 'input_image',
            image_url: `data:${img.mimeType};base64,${img.base64}`
        }))
    };
}

function defaultYunwuPayload(prompt, images = [], imageOptions = {}) {
    const parts = [
        {
            text: prompt || 'Generate an image.'
        }
    ];

    for (const img of images) {
        parts.push({
            inline_data: {
                mime_type: img.mimeType,
                data: img.base64
            }
        });
    }

    return {
        contents: [
            {
                role: 'user',
                parts
            }
        ],
        generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: {
                aspectRatio: imageOptions.aspectRatio,
                imageSize: imageOptions.providerResolution || normalizeResolutionForProvider(imageOptions.resolution)
            }
        }
    };
}

function buildProviderRequest(p, mode, variables, images, imageOptions) {
    const urlTemplate = p.url || '';
    const url = compileStringTemplate(urlTemplate, variables);

    const headers = compileTemplate(
        p.headers || {
            'Content-Type': 'application/json'
        },
        variables
    );

    let template;

    if (mode === 'img2img') {
        template = p.editPayloadTemplate || p.img2imgPayloadTemplate || p.payloadTemplate;
    } else {
        template = p.payloadTemplate || p.txt2imgPayloadTemplate;
    }

    let payload;

    if (template) {
        payload = compileTemplate(template, variables);
    } else if (p.providerType === 'yunwu-gemini') {
        payload = defaultYunwuPayload(variables.prompt, images, imageOptions);
    } else {
        throw new Error('当前预设没有 payloadTemplate / editPayloadTemplate，无法组装服务商请求。');
    }

    return {
        url,
        headers,
        payload
    };
}

// ================= 服务商响应处理 =================

async function pollIfNeeded(data, headers, task = null) {
    let finalData = data;

    if (finalData.response_url && finalData.status && String(finalData.status).includes('IN_QUEUE')) {
        logSafe('[特征嗅探] 识别为标准排队模式，开启 GET 轮询...');

        let pollCount = 0;

        while (true) {
            pollCount++;

            await sleep(3000);

            const progress = Math.min(88, 45 + pollCount * 5);

            if (task) {
                updateTask(task, {
                    progress,
                    stage: `服务商排队生成中，第 ${pollCount} 次查询`
                });
            }

            process.stdout.write(`\r> 正在排队生成中... (第 ${pollCount} 次查询)`);

            const pollRes = await axios.get(finalData.response_url, {
                headers
            });

            if (
                pollRes.data.status === 'COMPLETED' ||
                pollRes.data.images && pollRes.data.images.length > 0
            ) {
                console.log('\n[√] 图片已出炉！');

                if (task) {
                    updateTask(task, {
                        progress: 90,
                        stage: '服务商已返回结果'
                    });
                }

                finalData = pollRes.data;
                break;
            }

            if (pollRes.data.status === 'FAILED') {
                throw new Error('服务商生成任务失败 (FAILED)');
            }
        }
    } else {
        logSafe('[特征嗅探] 识别为同步直出 / Chat / Gemini 模式。');

        if (task) {
            updateTask(task, {
                progress: 70,
                stage: '服务商已返回结果'
            });
        }
    }

    return finalData;
}

function getByPossiblePaths(data, paths) {
    const list = Array.isArray(paths) ? paths : [paths].filter(Boolean);

    for (const p of list) {
        const value = _.get(data, p);

        if (value !== undefined && value !== null && value !== '') {
            return value;
        }
    }

    return undefined;
}

function looksLikeBase64Image(str) {
    if (typeof str !== 'string') return false;

    const s = str.replace(/[\r\n\s]/g, '');

    if (s.length < 200) return false;
    if (!/^[A-Za-z0-9+/=]+$/.test(s)) return false;

    return (
        s.startsWith('/9j/') ||
        s.startsWith('iVBOR') ||
        s.startsWith('UklGR') ||
        s.startsWith('R0lGOD') ||
        s.length > 1000
    );
}

function collectImageLikeValues(node, out = []) {
    if (node === null || node === undefined) return out;

    if (typeof node === 'string') {
        if (
            /data:image\/[\w.+-]+;base64,/i.test(node) ||
            /^https?:\/\//i.test(node) ||
            looksLikeBase64Image(node)
        ) {
            out.push(node);
        }

        return out;
    }

    if (Array.isArray(node)) {
        for (const item of node) {
            collectImageLikeValues(item, out);
        }

        return out;
    }

    if (typeof node === 'object') {
        if (node.url) out.push(node.url);
        if (node.b64_json) out.push(node.b64_json);
        if (node.base64) out.push(node.base64);

        if (node.inline_data?.data) {
            out.push({
                mimeType: node.inline_data.mime_type || 'image/png',
                base64: node.inline_data.data
            });
        }

        if (node.inlineData?.data) {
            out.push({
                mimeType: node.inlineData.mimeType || node.inlineData.mime_type || 'image/png',
                base64: node.inlineData.data
            });
        }

        for (const value of Object.values(node)) {
            collectImageLikeValues(value, out);
        }
    }

    return out;
}

function saveBase64ToLocal(base64, mimeType = 'image/png', prefix = 'img') {
    const clean = String(base64)
        .replace(/^data:image\/[^;]+;base64,/i, '')
        .replace(/[\r\n\s]/g, '')
        .trim();

    const ext = extFromMime(mimeType || guessMimeFromBase64(clean));

    const fileName = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}.${ext}`;
    const filePath = path.join(outputDir, fileName);

    fs.writeFileSync(filePath, Buffer.from(clean, 'base64'));

    return `http://127.0.0.1:${config.port}/outputs/${fileName}`;
}

function materializeOneImage(value, index = 0) {
    if (!value) return null;

    if (typeof value === 'object' && !Array.isArray(value)) {
        if (value.url) {
            return String(value.url);
        }

        if (value.b64_json) {
            return saveBase64ToLocal(
                value.b64_json,
                value.mimeType || value.mime_type || 'image/png',
                'img_b64'
            );
        }

        if (value.base64) {
            return saveBase64ToLocal(
                value.base64,
                value.mimeType || value.mime_type || 'image/png',
                'img_b64'
            );
        }
    }

    if (typeof value !== 'string') return null;

    const trimmed = value.trim();

    const dataUrl = parseDataUrl(trimmed);

    if (dataUrl) {
        logSafe('[处理] 服务商返回 dataURL / base64，转换为本地图床...');
        return saveBase64ToLocal(dataUrl.base64, dataUrl.mimeType, 'img_dataurl');
    }

    const markdownUrl = trimmed.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);

    if (markdownUrl) {
        return markdownUrl[1];
    }

    const urlMatch = trimmed.match(/(https?:\/\/[^\s\)"']+)/i);

    if (urlMatch) {
        logSafe('[处理] 服务商返回标准网络 URL:', urlMatch[1]);
        return urlMatch[1];
    }

    if (looksLikeBase64Image(trimmed)) {
        logSafe('[处理] 服务商返回裸 base64，转换为本地图床...');
        return saveBase64ToLocal(trimmed, guessMimeFromBase64(trimmed), `img_raw_${index}`);
    }

    return null;
}

function extractFinalImageUrls(finalData, p, mode) {
    const paths = mode === 'img2img'
        ? p.editResultPath || p.img2imgResultPath || p.resultPath
        : p.resultPath || p.txt2imgResultPath;

    let extracted = getByPossiblePaths(finalData, paths);
    let candidates = [];

    if (extracted !== undefined) {
        candidates = collectImageLikeValues(extracted);

        if (candidates.length === 0) {
            candidates = [extracted];
        }
    }

    if (candidates.length === 0) {
        logSafe('[结果提取] 指定路径未取到图片，启动全响应自动扫描...');
        candidates = collectImageLikeValues(finalData);
    }

    const urls = [];

    for (let i = 0; i < candidates.length; i++) {
        const url = materializeOneImage(candidates[i], i);

        if (url && !urls.includes(url)) {
            urls.push(url);
        }
    }

    if (urls.length === 0) {
        throw new Error(`没有从服务商响应中提取到图片。请检查 resultPath / editResultPath。响应预览: ${JSON.stringify(finalData).slice(0, 800)}`);
    }

    return urls;
}

// ================= 核心请求处理 =================

async function handleImageRequest(req, res, forcedMode = null) {
    req.setTimeout(0);

    const p = config.presets[config.activePreset];

    if (!p) {
        return res.status(400).json({
            error: 'No active preset',
            detail: '请先在预设管理里选择一个激活预设。'
        });
    }

    let task = null;

    try {
        const prompt = extractPrompt(req.body || {});
        const rawModel = req.body?.model || p.defaultModel || 'nano-banana';
        const mappedModel = p.modelMapping?.[rawModel] || rawModel;

        const imageOptions = validateImageOptions(rawModel, mappedModel, req.body || {});

        task = createTask({
            mode: forcedMode || 'auto',
            rawModel,
            mappedModel,
            modelFamily: imageOptions.modelFamily,
            prompt,
            aspectRatio: imageOptions.aspectRatio,
            resolution: imageOptions.resolution,
            size: imageOptions.size,
            width: imageOptions.width,
            height: imageOptions.height,
            imageCount: 0
        });

        updateTask(task, {
            progress: 8,
            stage: '解析输入图片与请求参数'
        });

        const images = await collectInputImages(req, task);
        const mode = forcedMode || (images.length > 0 ? 'img2img' : 'txt2img');

        updateTask(task, {
            mode,
            imageCount: images.length,
            progress: 25,
            stage: '请求已转译为服务商格式'
        });

        console.log(`\n\x1b[46m\x1b[30m [+] 新任务 \x1b[0m 模式: ${mode} | 模型: ${mappedModel} | 参考图: ${images.length} | 比例: ${imageOptions.aspectRatio} | 清晰度: ${imageOptions.resolution} | 尺寸: ${imageOptions.size} | 提示词: ${(prompt || '').substring(0, 30)}...`);

        const variables = buildVariables({
            prompt,
            rawModel,
            mappedModel,
            apiKey: p.apiKey || '',
            images,
            imageOptions
        });

        const { url, headers, payload } = buildProviderRequest(p, mode, variables, images, imageOptions);

        updateTask(task, {
            providerUrl: url,
            progress: 35,
            stage: '准备请求服务商'
        });

        logSafe('[转译] 服务商 URL:', url);
        logSafe('[转译] 服务商 Payload:', payload);

        updateTask(task, {
            progress: 45,
            stage: '服务商生成中'
        });

        const response = await axios.post(url, payload, {
            headers,
            timeout: 0,
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

        const finalData = await pollIfNeeded(response.data, headers, task);

        updateTask(task, {
            progress: 92,
            stage: '解析服务商图片结果'
        });

        const urls = extractFinalImageUrls(finalData, p, mode);

        finishTask(task, urls);

        return res.json({
            created: Math.floor(Date.now() / 1000),
            data: urls.map(url => ({
                url
            }))
        });

    } catch (error) {
        const errorMsg = error.response?.data || error.message;

        if (task) {
            failTask(task, errorMsg);
        }

        console.log('\n\x1b[31m================= 🚨 报错拦截 =================\x1b[0m');
        console.log(errorMsg);
        console.log('\x1b[31m================================================\x1b[0m');

        fs.appendFileSync(
            'error.log',
            `\n[${new Date().toLocaleString()}] Error: ${JSON.stringify(errorMsg)}`
        );

        return res.status(500).json({
            error: 'Gateway Error',
            detail: errorMsg
        });
    }
}

// ================= 全局路由挂载 =================

let isRouteMounted = false;

function mountRoutes() {
    if (isRouteMounted) return;

    app.post('/v1/images/generations', upload.any(), (req, res) => {
        handleImageRequest(req, res, null);
    });

    app.post('/v1/images/edits', upload.any(), (req, res) => {
        handleImageRequest(req, res, 'img2img');
    });

    app.post('/v1/images/variations', upload.any(), (req, res) => {
        handleImageRequest(req, res, 'img2img');
    });

    app.post('/images/generations', upload.any(), (req, res) => {
        handleImageRequest(req, res, null);
    });

    app.post('/images/edits', upload.any(), (req, res) => {
        handleImageRequest(req, res, 'img2img');
    });

    app.post('/images/variations', upload.any(), (req, res) => {
        handleImageRequest(req, res, 'img2img');
    });

    app.get('/v1/models', (req, res) => {
        const p = config.presets[config.activePreset] || {};
        const ids = Object.keys(p.modelMapping || {});

        res.json({
            object: 'list',
            data: ids.map(id => ({
                id,
                object: 'model',
                owned_by: 'zixuan-gateway'
            }))
        });
    });

    app.get('/tasks', (req, res) => {
        res.json({
            activePreset: config.activePreset || null,
            total: tasks.size,
            tasks: Array.from(tasks.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        });
    });

    app.get('/v1/tasks', (req, res) => {
        res.json({
            activePreset: config.activePreset || null,
            total: tasks.size,
            tasks: Array.from(tasks.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        });
    });

    app.get('/tasks/:id', (req, res) => {
        const task = tasks.get(req.params.id);

        if (!task) {
            return res.status(404).json({
                error: 'Task not found'
            });
        }

        res.json(task);
    });

    app.get('/health', (req, res) => {
        res.json({
            ok: true,
            activePreset: config.activePreset || null,
            runningTasks: Array.from(tasks.values()).filter(t => t.status === 'running').length
        });
    });

    isRouteMounted = true;
}

// ================= Yunwu / Gemini 快速预设 =================

function createYunwuGeminiPreset(name, apiKey, useQueryKey = false, useApiDomain = false) {
    const host = useApiDomain ? 'https://api.yunwu.ai' : 'https://yunwu.ai';

    return {
        providerType: 'yunwu-gemini',

        defaultModel: 'nano-banana',

        url: useQueryKey
            ? `${host}/v1beta/models/{{model}}:generateContent?key={{apiKey}}`
            : `${host}/v1beta/models/{{model}}:generateContent`,

        apiKey,

        headers: {
            'Authorization': 'Bearer {{apiKey}}',
            'Content-Type': 'application/json'
        },

        modelMapping: {
            'nano-banana': 'gemini-3-pro-image-preview',
            'banana': 'gemini-3-pro-image-preview',

            'nano-banana-pro': 'gemini-3-pro-image-preview',
            'banana-pro': 'gemini-3-pro-image-preview',

            'nano-banana-2': 'gemini-3.1-flash-image-preview',
            'nano-banana2': 'gemini-3.1-flash-image-preview',
            'banana2': 'gemini-3.1-flash-image-preview'
        },

        payloadTemplate: {
            contents: [
                {
                    role: 'user',
                    parts: [
                        {
                            text: '{{prompt}}'
                        }
                    ]
                }
            ],
            generationConfig: {
                responseModalities: ['IMAGE'],
                imageConfig: {
                    aspectRatio: '{{aspect_ratio}}',
                    imageSize: '{{providerResolution}}'
                }
            }
        },

        editPayloadTemplate: {
            contents: [
                {
                    role: 'user',
                    parts: '{{geminiParts}}'
                }
            ],
            generationConfig: {
                responseModalities: ['IMAGE'],
                imageConfig: {
                    aspectRatio: '{{aspect_ratio}}',
                    imageSize: '{{providerResolution}}'
                }
            }
        },

        resultPath: [
            'candidates[0].content.parts[0].inlineData.data',
            'candidates[0].content.parts[1].inlineData.data',
            'candidates[0].content.parts[2].inlineData.data',
            'candidates[0].content.parts[0].inline_data.data',
            'candidates[0].content.parts[1].inline_data.data',
            'candidates[0].content.parts[2].inline_data.data',
            'candidates[0].content.parts[0].text',
            'candidates[0].content.parts[1].text',
            'candidates[0].content.parts[2].text'
        ],

        editResultPath: [
            'candidates[0].content.parts[0].inlineData.data',
            'candidates[0].content.parts[1].inlineData.data',
            'candidates[0].content.parts[2].inlineData.data',
            'candidates[0].content.parts[0].inline_data.data',
            'candidates[0].content.parts[1].inline_data.data',
            'candidates[0].content.parts[2].inline_data.data',
            'candidates[0].content.parts[0].text',
            'candidates[0].content.parts[1].text',
            'candidates[0].content.parts[2].text'
        ]
    };
}

// ================= UI 与核心控制流 =================

async function startUI() {
    loadConfig();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    mountRoutes();

    while (true) {
        console.clear();
        console.log(BANNER);

        console.log('\n==== 主菜单 ====');
        console.log(`[1] 启动网关 (当前预设: \x1b[32m${config.activePreset || '未选择'}\x1b[0m)`);
        console.log('[2] 预设管理 (添加/删除/切换)');
        console.log(`[3] 修改端口 (当前: ${config.port})`);
        console.log('[4] 查看支持的比例与分辨率');
        console.log('[0] 退出程序');

        const choice = await askMenuChoice(rl, ['1', '2', '3', '4', '0']);

        if (choice === '1') {
            if (!config.activePreset || !config.presets[config.activePreset]) {
                console.log('\x1b[31m❌ 请先去 [预设管理] 选择一个配置！\x1b[0m');
                await sleep(1500);
                continue;
            }

            await runGatewayMode(rl);

        } else if (choice === '2') {
            await presetManager(rl);

        } else if (choice === '3') {
            await changePort(rl);

        } else if (choice === '4') {
            console.clear();
            console.log(BANNER);
            printModelRules();
            await waitEnter(rl);

        } else if (choice === '0') {
            console.log('再见！');
            process.exit(0);
        }
    }
}

async function changePort(rl) {
    while (true) {
        const result = await askInput(rl, '输入新端口 1024-65535', {
            allowEmpty: false,
            allowBack: true,
            allowExit: true
        });

        if (result.type === 'back' || result.type === 'exit') return;

        const port = parseInt(result.value, 10);

        if (port >= 1024 && port <= 65535) {
            config.port = port;
            saveConfig();
            console.log('✅ 端口已保存。');
            await sleep(1000);
            return;
        }

        console.log('\x1b[31m❌ 端口不合法，请输入 1024-65535 之间的数字。\x1b[0m');
    }
}

function printModelRules() {
    console.log('\n================= 模型尺寸规则 =================');
    console.log('基础 banana / banana-pro 支持比例：');
    console.log(`  ${BASIC_RATIOS.join(' | ')}`);
    console.log('\nbanana2 支持比例：');
    console.log(`  ${BANANA2_RATIOS.join(' | ')}`);
    console.log('\n所有模型支持清晰度：');
    console.log(`  ${ALLOWED_RESOLUTIONS.join(' | ')}`);
    console.log('\n常用换算示例：');
    console.log('  1k + 1:1  -> 1024x1024');
    console.log('  1k + 16:9 -> 1024x576');
    console.log('  2k + 16:9 -> 2048x1152');
    console.log('  4k + 9:16 -> 2304x4096');
    console.log('================================================');
}

async function runGatewayMode(rl) {
    console.clear();
    console.log(BANNER);

    return new Promise((resolve) => {
        const server = app.listen(config.port, () => {
            console.log(`\x1b[32m🚀 网关已点火 | 监听端口: ${config.port}\x1b[0m`);
            console.log('\x1b[33m📂 图床已开启 | 记录保存在 /outputs\x1b[0m');

            console.log(`\n接入地址: \x1b[4mhttp://127.0.0.1:${config.port}\x1b[0m`);

            console.log('\n支持接口:');
            console.log(`  文生图: POST http://127.0.0.1:${config.port}/v1/images/generations`);
            console.log(`  图生图: POST http://127.0.0.1:${config.port}/v1/images/edits`);
            console.log(`  变体图: POST http://127.0.0.1:${config.port}/v1/images/variations`);
            console.log(`  任务表: GET  http://127.0.0.1:${config.port}/tasks`);

            console.log('\n控制台命令:');
            console.log("  输入 't' 并回车：查看正在运行 / 历史任务列表");
            console.log("  输入 'b' 并回车：安全关闭并返回主菜单\n");
        });

        server.on('error', (err) => {
            console.log('\x1b[31m❌ 网关启动失败：\x1b[0m', err.message);

            if (err.code === 'EADDRINUSE') {
                console.log(`端口 ${config.port} 已被占用。请回主菜单修改端口，或关闭占用这个端口的程序。`);
            }

            setTimeout(resolve, 1200);
        });

        async function waitCommand() {
            const cmd = await rl.question('');

            if (cmd.trim().toLowerCase() === 'b') {
                console.log('\n\x1b[33m🛑 正在断开连接...\x1b[0m');

                server.close(() => {
                    console.log('\x1b[32m✅ 网关已成功停止！返回主菜单...\x1b[0m');
                    setTimeout(resolve, 800);
                });

            } else if (cmd.trim().toLowerCase() === 't') {
                printTaskList();
                waitCommand();

            } else {
                console.log("请输入 't' 查看任务，或输入 'b' 返回主菜单。");
                waitCommand();
            }
        }

        waitCommand();
    });
}

// ================= 预设管理 =================

async function presetManager(rl) {
    while (true) {
        console.clear();
        console.log(BANNER);

        console.log('\n--- 预设管理 ---');

        const names = Object.keys(config.presets || {});

        if (names.length === 0) {
            console.log('暂无预设。');
        } else {
            names.forEach((n, i) => {
                console.log(`[${i + 1}] ${n} ${config.activePreset === n ? '\x1b[32m(当前激活)\x1b[0m' : ''}`);
            });
        }

        console.log('----------------');
        console.log('[Y] 快速添加 Yunwu/Gemini 图生图预设');
        console.log('[A] 添加通用 API 预设');
        console.log('[D] 删除预设');
        console.log('[S] 切换激活预设');
        console.log('[B] 返回主菜单');

        const op = await askMenuChoice(rl, ['Y', 'A', 'D', 'S', 'B', 'y', 'a', 'd', 's', 'b']);
        const upper = op.toUpperCase();

        try {
            if (upper === 'B') return;

            if (upper === 'Y') {
                await createYunwuPresetWizard(rl);
            }

            if (upper === 'A') {
                await createGenericPresetWizard(rl);
            }

            if (upper === 'D') {
                await deletePresetWizard(rl);
            }

            if (upper === 'S') {
                await switchPresetWizard(rl);
            }
        } catch (e) {
            console.log('\x1b[31m❌ 操作出错，但程序没有退出。\x1b[0m');
            console.log(e.message);
            await waitEnter(rl);
        }
    }
}

async function deletePresetWizard(rl) {
    const result = await askInput(rl, '输入要删除的预设名称', {
        allowEmpty: false,
        allowBack: true,
        allowExit: true
    });

    if (result.type !== 'value') return;

    const name = result.value.trim();

    if (!config.presets[name]) {
        console.log('❌ 没有这个预设。');
        await sleep(1000);
        return;
    }

    delete config.presets[name];

    if (config.activePreset === name) {
        config.activePreset = null;
    }

    saveConfig();
    console.log('✅ 预设已删除。');
    await sleep(1000);
}

async function switchPresetWizard(rl) {
    const result = await askInput(rl, '输入要激活的预设名称', {
        allowEmpty: false,
        allowBack: true,
        allowExit: true
    });

    if (result.type !== 'value') return;

    const name = result.value.trim();

    if (config.presets[name]) {
        config.activePreset = name;
        saveConfig();

        console.log('✅ 激活成功！');
        await sleep(1000);
    } else {
        console.log('❌ 没有这个预设。');
        await sleep(1000);
    }
}

async function createYunwuPresetWizard(rl) {
    let step = 1;

    const state = {
        name: 'yunwu-gemini-image',
        apiKey: '',
        useQueryKey: false,
        useApiDomain: false
    };

    while (true) {
        console.clear();
        console.log(BANNER);
        console.log('\n--- 快速添加 Yunwu/Gemini 图生图预设 ---');
        console.log("提示：输入 b 返回上一步，输入 exit 放弃。");

        if (step === 1) {
            const r = await askInput(rl, '预设名称', {
                allowEmpty: true,
                defaultValue: state.name
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') return;

            state.name = r.value.trim() || state.name;
            step = 2;
            continue;
        }

        if (step === 2) {
            const r = await askInput(rl, 'API Key，填 sk- 开头的 key', {
                allowEmpty: false
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 1;
                continue;
            }

            state.apiKey = r.value.replace(/[\r\n]/g, '').trim();
            step = 3;
            continue;
        }

        if (step === 3) {
            console.log('\n域名选择：');
            console.log('[1] https://yunwu.ai');
            console.log('[2] https://api.yunwu.ai');

            const r = await askInput(rl, '选择域名', {
                allowEmpty: true,
                defaultValue: '1'
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 2;
                continue;
            }

            if (!['1', '2'].includes(r.value.trim())) {
                console.log('❌ 请输入 1 或 2。');
                await sleep(800);
                continue;
            }

            state.useApiDomain = r.value.trim() === '2';
            step = 4;
            continue;
        }

        if (step === 4) {
            console.log('\n鉴权方式：');
            console.log('[1] Header Bearer，不在 URL 带 key');
            console.log('[2] URL ?key={{apiKey}} + Header Bearer');

            const r = await askInput(rl, '选择鉴权方式', {
                allowEmpty: true,
                defaultValue: '1'
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 3;
                continue;
            }

            if (!['1', '2'].includes(r.value.trim())) {
                console.log('❌ 请输入 1 或 2。');
                await sleep(800);
                continue;
            }

            state.useQueryKey = r.value.trim() === '2';

            const preset = createYunwuGeminiPreset(
                state.name,
                state.apiKey,
                state.useQueryKey,
                state.useApiDomain
            );

            config.presets[state.name] = preset;
            config.activePreset = state.name;
            saveConfig();

            console.log('✅ Yunwu/Gemini 图生图预设已添加并激活。');
            console.log('✅ 已内置文生图、图生图、多图生图、比例、1K/2K/4K。');
            await waitEnter(rl);
            return;
        }
    }
}

async function createGenericPresetWizard(rl) {
    const state = {
        name: '',
        url: '',
        apiKey: '',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer {{apiKey}}'
        },
        modelMapping: {},
        payloadTemplate: undefined,
        editPayloadTemplate: undefined,
        resultPath: undefined
    };

    let step = 1;

    while (true) {
        console.clear();
        console.log(BANNER);
        console.log('\n--- 添加通用 API 预设 ---');
        console.log("提示：输入 b 返回上一步，输入 exit 放弃。");
        console.log('可用变量：{{prompt}}, {{model}}, {{rawModel}}, {{apiKey}}, {{aspect_ratio}}, {{providerResolution}}, {{resolution}}, {{size}}, {{width}}, {{height}}, {{geminiParts}}, {{imageDataUrl}}');

        if (step === 1) {
            const r = await askInput(rl, '预设名称', {
                allowEmpty: false
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') return;

            state.name = r.value.trim();
            step = 2;
            continue;
        }

        if (step === 2) {
            const r = await askInput(rl, '接口 URL，可带 {{model}} / {{apiKey}}', {
                allowEmpty: false
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 1;
                continue;
            }

            state.url = r.value.trim();
            step = 3;
            continue;
        }

        if (step === 3) {
            const r = await askInput(rl, 'API Key，没有就填 none', {
                allowEmpty: true,
                defaultValue: ''
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 2;
                continue;
            }

            const key = r.value.replace(/[\r\n]/g, '').trim();
            state.apiKey = key === 'none' ? '' : key;
            step = 4;
            continue;
        }

        if (step === 4) {
            const r = await askJson(rl, 'Headers JSON，留空使用默认 Bearer', {
                allowEmpty: true,
                defaultValue: state.headers,
                example: '{"Authorization":"Bearer {{apiKey}}","Content-Type":"application/json"}'
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 3;
                continue;
            }

            state.headers = r.value;
            step = 5;
            continue;
        }

        if (step === 5) {
            const r = await askInput(rl, '模型映射，例 nano-banana:xxx,nano-banana-pro:xxx,nano-banana-2:xxx，可留空', {
                allowEmpty: true,
                defaultValue: ''
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 4;
                continue;
            }

            const modelMapping = {};
            const raw = r.value.trim();

            if (raw) {
                raw.split(',').forEach(item => {
                    const [k, ...rest] = item.split(':');
                    const v = rest.join(':');

                    if (k && v) {
                        modelMapping[k.trim()] = v.trim();
                    }
                });
            }

            state.modelMapping = modelMapping;
            step = 6;
            continue;
        }

        if (step === 6) {
            const r = await askJson(rl, '文生图 payloadTemplate JSON', {
                allowEmpty: false,
                example: '{"contents":[{"role":"user","parts":[{"text":"{{prompt}}"}]}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"aspectRatio":"{{aspect_ratio}}","imageSize":"{{providerResolution}}"}}}'
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 5;
                continue;
            }

            state.payloadTemplate = r.value;
            step = 7;
            continue;
        }

        if (step === 7) {
            const r = await askJson(rl, '图生图 editPayloadTemplate JSON，留空则复用文生图模板', {
                allowEmpty: true,
                defaultValue: undefined,
                example: '{"contents":[{"role":"user","parts":"{{geminiParts}}"}],"generationConfig":{"responseModalities":["IMAGE"],"imageConfig":{"aspectRatio":"{{aspect_ratio}}","imageSize":"{{providerResolution}}"}}}'
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 6;
                continue;
            }

            state.editPayloadTemplate = r.value;
            step = 8;
            continue;
        }

        if (step === 8) {
            const r = await askInput(rl, '结果提取路径，多个路径用英文逗号分隔，留空自动扫描', {
                allowEmpty: true,
                defaultValue: ''
            });

            if (r.type === 'exit') return;
            if (r.type === 'back') {
                step = 7;
                continue;
            }

            const raw = r.value.trim();

            state.resultPath = raw
                ? raw.split(',').map(s => s.trim()).filter(Boolean)
                : undefined;

            config.presets[state.name] = {
                providerType: 'generic',
                defaultModel: 'nano-banana',
                url: state.url,
                apiKey: state.apiKey,
                headers: state.headers,
                modelMapping: state.modelMapping,
                payloadTemplate: state.payloadTemplate,
                editPayloadTemplate: state.editPayloadTemplate,
                resultPath: state.resultPath,
                editResultPath: state.resultPath
            };

            config.activePreset = state.name;
            saveConfig();

            console.log('✅ 通用预设已添加并激活。');
            await waitEnter(rl);
            return;
        }
    }
}

// 启动点火
startUI().catch(err => {
    console.log('\x1b[31m程序遇到未处理错误，但这里已经拦截：\x1b[0m');
    console.log(err);
    process.exit(1);
});