const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const GIT_CONFIG_FILE = path.join(__dirname, 'git-config.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // 默认密码，启动时可改
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
const ROLES = {
    admin: '管理员',
    config: '配置人员',
    developer: '普通开发人员'
};

// session tokens in memory (cleared on restart)
const sessions = {};

if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ _version: 0, years: [], windows: [] }, null, 2));
}
if (!fs.existsSync(GIT_CONFIG_FILE)) {
    fs.writeFileSync(GIT_CONFIG_FILE, JSON.stringify({ provider: 'github', gitlab: { host: '', token: '' }, github: { owner: '', repo: '', token: '' } }, null, 2));
}
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({
        users: [createUserRecord({ username: 'admin', name: '管理员', role: 'admin', password: ADMIN_PASSWORD })]
    }, null, 2));
}

function readAll() {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
    catch (e) { return { _version: 0, years: [], windows: [] }; }
}
function writeAll(obj) {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}
function readGitConfig() {
    try { return JSON.parse(fs.readFileSync(GIT_CONFIG_FILE, 'utf-8')); }
    catch (e) { return {}; }
}
function writeGitConfig(obj) {
    fs.writeFileSync(GIT_CONFIG_FILE + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(GIT_CONFIG_FILE + '.tmp', GIT_CONFIG_FILE);
}
function readUsers() {
    try {
        const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
        return { users: Array.isArray(raw.users) ? raw.users : [] };
    } catch (e) {
        return { users: [] };
    }
}
function writeUsers(obj) {
    fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify(obj, null, 2));
    fs.renameSync(USERS_FILE + '.tmp', USERS_FILE);
}
function userId() {
    return 'u_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
}
function hashPassword(password, salt) {
    return crypto.createHash('sha256').update(String(salt) + ':' + String(password)).digest('hex');
}
function setUserPassword(user, password) {
    const salt = crypto.randomBytes(16).toString('hex');
    user.salt = salt;
    user.passwordHash = hashPassword(password || '', salt);
    user.passwordPlain = String(password || '');
    return user;
}
function createUserRecord(input) {
    const user = {
        id: input.id || userId(),
        username: String(input.username || '').trim(),
        name: String(input.name || input.username || '').trim(),
        role: ROLES[input.role] ? input.role : 'developer',
        disabled: Boolean(input.disabled)
    };
    return setUserPassword(user, input.password || '');
}
function sanitizeUser(user, includePassword) {
    const result = {
        id: user.id,
        username: user.username,
        name: user.name || user.username,
        role: ROLES[user.role] ? user.role : 'developer',
        roleLabel: ROLES[ROLES[user.role] ? user.role : 'developer'],
        disabled: Boolean(user.disabled)
    };
    if (includePassword) {
        result.passwordText = user.passwordPlain || '';
        result.passwordReadable = Boolean(user.passwordPlain);
    }
    return result;
}
function verifyPassword(user, password) {
    if (!user || user.disabled) return false;
    return user.passwordHash === hashPassword(password || '', user.salt || '');
}
function getSession(req) {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return token && sessions[token] ? sessions[token] : null;
}

function sanitizeGitConfig(cfg) {
    const github = cfg.github || {};
    const gitlab = cfg.gitlab || {};
    return {
        provider: cfg.provider || 'github',
        github: {
            owner: github.owner || '',
            repo: github.repo || '',
            hasToken: Boolean(github.token)
        },
        gitlab: {
            host: gitlab.host || '',
            hasToken: Boolean(gitlab.token)
        }
    };
}

function mergeGitConfig(incoming, current) {
    const next = {
        provider: incoming.provider || current.provider || 'github',
        github: Object.assign({}, current.github || {}, incoming.github || {}),
        gitlab: Object.assign({}, current.gitlab || {}, incoming.gitlab || {})
    };
    if (!incoming.github || !incoming.github.token) next.github.token = (current.github || {}).token || '';
    if (!incoming.gitlab || !incoming.gitlab.token) next.gitlab.token = (current.gitlab || {}).token || '';
    return next;
}

function json(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function checkAdmin(req) {
    const session = getSession(req);
    return session && session.role === 'admin';
}
function issueSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const sessionUser = sanitizeUser(user);
    sessions[token] = Object.assign({ issuedAt: Date.now() }, sessionUser);
    return { token, user: sessionUser };
}
function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function developerComparableData(obj) {
    const clone = JSON.parse(JSON.stringify(obj || {}));
    delete clone._version;
    (clone.windows || []).forEach(win => {
        (win.requirements || []).forEach(req => {
            req.modules = '__editable_by_developer__';
            req.sqlFiles = '__editable_by_developer__';
            req.apis = '__editable_by_developer__';
        });
    });
    return clone;
}
function canWriteData(role, current, incoming) {
    if (role === 'admin' || role === 'config') return { ok: true };
    if (role !== 'developer') return { ok: false, message: '当前用户没有保存权限' };
    if (deepEqual(developerComparableData(current), developerComparableData(incoming))) return { ok: true };
    return { ok: false, message: '普通开发人员只能编辑代码模块、数据库清单和 API' };
}
function adminCount(users) {
    return users.filter(u => u.role === 'admin' && !u.disabled).length;
}

function readBody(req, cb) {
    let body = '';
    req.on('data', c => {
        body += c;
        if (body.length > 1024 * 1024 * 10) req.destroy();
    });
    req.on('end', () => cb(body));
}

function providerToken(cfg) {
    const provider = cfg.provider || 'github';
    return provider === 'github'
        ? ((cfg.github || {}).token || '')
        : ((cfg.gitlab || {}).token || '');
}

function requestJson(url, headers, cb) {
    var mod = url.startsWith('https') ? https : http;
    var req = mod.get(url, { headers: headers }, function(res) {
        var body = '';
        res.on('data', function(c) { body += c; });
        res.on('end', function() {
            var data = null;
            try { data = body ? JSON.parse(body) : null; } catch (e) {}
            if (res.statusCode < 200 || res.statusCode >= 300) {
                var err = new Error('HTTP ' + res.statusCode);
                err.status = res.statusCode;
                err.body = data;
                return cb(err);
            }
            cb(null, data);
        });
    });
    req.on('error', cb);
    req.setTimeout(15000, function() { req.destroy(); cb(new Error('请求超时')); });
}

// ========== Production Manual DOCX ==========
function xmlEscape(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDateCn(date) {
    const s = String(date || '');
    if (!/^\d{8}$/.test(s)) return s || '';
    return Number(s.slice(0, 4)) + '年' + Number(s.slice(4, 6)) + '月' + Number(s.slice(6, 8)) + '日';
}

function getWindowDeployPeople(win) {
    const people = Array.isArray(win.deployPeople) ? win.deployPeople : [win.deployPerson1 || '', win.deployPerson2 || ''];
    return [String(people[0] || '').trim(), String(people[1] || '').trim()].filter(Boolean);
}

function displayModuleName(module) {
    const name = String((module && (module.name || module.full_name)) || '').trim();
    return name.indexOf('/') > -1 ? name.split('/').pop() : name;
}

function unique(values) {
    const seen = {};
    return values.filter(v => {
        v = String(v || '').trim();
        if (!v || seen[v]) return false;
        seen[v] = true;
        return true;
    });
}

function dbApplyUser(dbName) {
    const db = String(dbName || '').toLowerCase();
    if (db === 'db_cm') return 'u_cm';
    if (db === 'db_core') return 'u_core';
    if (db === 'db_ac') return 'u_ac';
    return 'u_core';
}

function manualText(value, fallback) {
    const text = String(value || '').trim();
    return text || fallback;
}

function sqlDbName(item) {
    const sql = (item && item.sql) || {};
    return String(sql.dbName || 'db_cm').trim() || 'db_cm';
}

function groupSqlsByDb(sqls) {
    const byDb = {};
    const groups = [];
    (sqls || []).forEach(item => {
        const db = sqlDbName(item);
        const key = db.toLowerCase();
        if (!byDb[key]) {
            byDb[key] = { db, items: [] };
            groups.push(byDb[key]);
        }
        byDb[key].items.push(item);
    });
    return groups;
}

function formatDateTimeForSql(date) {
    const pad = n => String(n).padStart(2, '0');
    return date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate()
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function buildSqlDownloadContent(sql, req, dbName, generatedAt) {
    return '-- 数据库：' + dbName + '\n'
        + '-- 需求：' + (req.name || '') + '（' + (req.number || '') + '）\n'
        + '-- 解决人：' + (req.resolver || '') + '\n'
        + '-- 生成时间：' + generatedAt + '\n\n'
        + '-- ========== 查询 ==========\n' + (sql.query || '-- (无)') + '\n\n'
        + '-- ========== 执行 ==========\n' + (sql.execute || '-- (无)') + '\n\n'
        + '-- ========== 回退 ==========\n' + (sql.rollback || '-- (无)') + '\n';
}

function docParagraph(text, style) {
    const pStyle = style ? '<w:pPr><w:pStyle w:val="' + style + '"/></w:pPr>' : '';
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const runs = lines.map((line, i) => '<w:r>' + (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + xmlEscape(line) + '</w:t></w:r>').join('');
    return '<w:p>' + pStyle + runs + '</w:p>';
}

function docHeading(text, level) {
    return docParagraph(text, level === 1 ? 'Heading1' : level === 2 ? 'Heading2' : level === 4 ? 'Heading4' : 'Heading3');
}

const MANUAL_FILL = 'FFF2CC';

function manualCell(text) {
    return { text: text == null ? '' : text, fill: MANUAL_FILL };
}

function cellText(cell) {
    return cell && typeof cell === 'object' && !Array.isArray(cell) ? cell.text : cell;
}

function cellFill(cell) {
    return cell && typeof cell === 'object' && !Array.isArray(cell) ? cell.fill : '';
}

function docTable(rows, colWeights) {
    const tableWidth = 9026;
    const colCount = Math.max(1, Math.max.apply(null, rows.map(row => row.length)));
    const weights = Array.from({ length: colCount }, (_, i) => {
        const value = Array.isArray(colWeights) ? Number(colWeights[i]) : 1;
        return value > 0 ? value : 1;
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    let usedWidth = 0;
    const colWidths = weights.map((weight, i) => {
        if (i === colCount - 1) return tableWidth - usedWidth;
        const width = Math.floor(tableWidth * weight / totalWeight);
        usedWidth += width;
        return width;
    });
    const grid = '<w:tblGrid>' + colWidths.map(width => '<w:gridCol w:w="' + width + '"/>').join('') + '</w:tblGrid>';
    return '<w:tbl><w:tblPr><w:tblW w:w="' + tableWidth + '" w:type="dxa"/><w:jc w:val="center"/><w:tblLayout w:type="fixed"/><w:tblBorders>'
        + '<w:top w:val="single" w:sz="4" w:space="0" w:color="B8C4D6"/>'
        + '<w:left w:val="single" w:sz="4" w:space="0" w:color="B8C4D6"/>'
        + '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="B8C4D6"/>'
        + '<w:right w:val="single" w:sz="4" w:space="0" w:color="B8C4D6"/>'
        + '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9E2EF"/>'
        + '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9E2EF"/>'
        + '</w:tblBorders><w:tblCellMar><w:top w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar></w:tblPr>'
        + grid
        + rows.map((row, ri) => '<w:tr>' + row.map((cell, ci) => {
            const fill = cellFill(cell) || (ri === 0 ? 'EAF1FB' : '');
            return '<w:tc><w:tcPr><w:tcW w:w="' + colWidths[ci] + '" w:type="dxa"/>'
                + (fill ? '<w:shd w:fill="' + fill + '"/>' : '') + '</w:tcPr>' + docParagraph(cellText(cell), ri === 0 ? 'TableHeader' : '') + '</w:tc>';
        }).join('') + '</w:tr>').join('')
        + '</w:tbl>';
}

const MANUAL_PACKAGE_OPTIONS = [
    { value: 'core', packageName: 'core-dist', fileLabel: '【core-dist 投产包文件名】', description: '核心业务主包' },
    { value: 'gl', packageName: 'gl-dist', fileLabel: '【gl-dist 投产包文件名】', description: 'gl相关服务包' },
    { value: 'cm', packageName: 'cm-dist', fileLabel: '【cm-dist 投产包文件名】', description: '公共组件、公共服务或配置' }
];

function getManualPackages(win) {
    const selected = Array.isArray((win || {}).manualPackages) ? win.manualPackages : [];
    const seen = {};
    return selected.map(v => String(v || '').trim().toLowerCase()).filter(v => {
        if (!MANUAL_PACKAGE_OPTIONS.some(opt => opt.value === v) || seen[v]) return false;
        seen[v] = true;
        return true;
    });
}

function manualPackageOptions(win) {
    const selected = getManualPackages(win);
    return MANUAL_PACKAGE_OPTIONS.filter(opt => selected.indexOf(opt.value) !== -1);
}

function manualReadyErrors(win) {
    const people = getWindowDeployPeople(win);
    const errors = [];
    if (people.length < 2) {
        errors.push('请填写两名投产人员');
    } else if (people[0] === people[1]) {
        errors.push('两名投产人员不能相同');
    }
    if (getManualPackages(win).length === 0) {
        errors.push('请选择投产包清单');
    }
    return errors;
}

function collectManualData(win) {
    const reqs = (win.requirements || []).filter(r => (r.status || 'normal') !== 'delayed');
    const modules = unique([].concat.apply([], reqs.map(r => (r.modules || []).map(displayModuleName))));
    const sqls = [];
    const apis = [];
    reqs.forEach(req => {
        (req.sqlFiles || []).forEach((sql, index) => sqls.push({ req, sql, index }));
        (req.apis || []).forEach((api, index) => apis.push({ req, api, index }));
    });
    return {
        reqs,
        modules,
        sqls,
        apis,
        people: getWindowDeployPeople(win)
    };
}

function buildManualDocumentXml(win) {
    const m = collectManualData(win);
    const dateText = formatDateCn(win.date);
    const dateCode = String(win.date || '');
    const uploadDate = dateCode || '投产窗口日期';
    const title = '金华银行核心系统投产手册';
    const deployPeople = m.people.length ? m.people.join('、') : '童若望、金伟峰';
    const modulesText = m.modules.length ? m.modules.join('、') : '无';
    const jenkinsAccessText = '进入Jenkins：21.10.8.79:8080，账号admin，密码Ab123456。';
    const deployStepsText = '请按实际 Jenkins 任务填写构建参数、部署顺序、日志检查和验证要求。';
    const sqlGroups = groupSqlsByDb(m.sqls);
    const orderedSqls = [].concat.apply([], sqlGroups.map(group => group.items));
    const packageOptions = manualPackageOptions(win);
    const packageNamesText = packageOptions.map(opt => opt.value).join('、') || '所选投产包';
    const sqlGeneratedAt = formatDateTimeForSql(new Date());
    let body = '';

    body += docParagraph('金华银行', 'Title');
    body += docParagraph(title, 'Title');
    body += docTable([
        ['投产日期', dateText],
        ['系统名称', '核心系统'],
        ['编制人', deployPeople.split('、')[0] || '童若望'],
        ['文档版本', 'V1.0']
    ]);
    body += docParagraph('说明：本手册用于核心系统投产包上传、部署、数据库脚本执行、验证及回退操作。');

    body += docHeading('1. 投产基本信息', 1);
    body += docParagraph('本章节用于记录本次核心系统投产的基本信息、时间窗口、参与人员及总体要求。投产操作前，需确保投产需求、投产包、数据库脚本、验证人员、回退人员均已确认。');
    body += docTable([
        ['项目', '内容'],
        ['投产日期', dateText],
        ['投产窗口', '22:00'],
        ['系统名称', '核心系统'],
        ['涉及模块', modulesText],
        ['投产环境', '生产环境'],
        ['牵头部门', '金华银行科技部'],
        ['投产负责人', deployPeople]
    ]);
    body += docHeading('投产总体原则', 2);
    body += docParagraph('1. 严格按照已审批的投产需求、投产包和数据库脚本清单执行，禁止临时替换未经审核的文件。');
    body += docParagraph('2. 所有操作须保留日志，包括包上传日志、部署命令记录、数据库执行日志、验证截图或验证结果。');
    body += docParagraph('3. 投产前必须完成备份，投产后必须完成技术验证和业务验证，若触发回退条件应及时启动回退。');

    body += docHeading('2. 投产需求清单（共 ' + m.reqs.length + ' 个）', 1);
    body += docParagraph('投产需求清单用于登记本次投产涉及的需求、缺陷和优化事项，作为投产范围控制依据。');
    const reqRows = [['序号', '需求编号', '需求/缺陷名称', '涉及模块', '是否含脚本', 'API', '是否现场验证', '业务人员']];
    m.reqs.forEach((req, i) => {
        const reqModules = unique((req.modules || []).map(displayModuleName)).join('、') || '-';
        const hasSql = (req.sqlFiles || []).length > 0;
        const hasApi = (req.apis || []).length > 0;
        reqRows.push([String(i + 1), req.number || '', req.name || '', reqModules, hasSql ? '☑' : '', hasApi ? '☑' : '', '是', req.businessPerson || '']);
    });
    if (reqRows.length === 1) reqRows.push(['', '', '本次投产暂无需求', '', '', '', '', '']);
    body += docTable(reqRows, [0.55, 1.45, 2.25, 1.45, 0.9, 0.65, 1.05, 1.1]);

    body += docHeading('3. 投产包清单', 1);
    body += docParagraph('本章节用于登记本次投产包清单，投产包范围由投产窗口中选择的 core、gl、cm 自动生成。投产前应核对包名、包文件名、构建时间、上传路径、部署路径及文件校验值，确保与审批材料一致。');
    body += docTable([['序号', '包名', '包文件名', '说明']].concat(packageOptions.map((opt, i) => [
        String(i + 1),
        opt.packageName,
        manualCell(opt.fileLabel),
        opt.description
    ])), [0.55, 1.15, 3.3, 2.3]);
    body += docHeading('包清单核对要求', 2);
    body += docParagraph('1. 包文件名、版本号、投产分支、构建时间需与投产审批材料一致。');
    body += docParagraph('2. 上传完成后需执行文件大小和校验值核对，防止上传中断、覆盖错误或文件损坏。');
    body += docParagraph('3. 若 gl、cm、core 之间存在依赖关系，应在说明中明确部署先后顺序和兼容要求。');

    body += docHeading('4. 数据库脚本清单（共 ' + orderedSqls.length + ' 个）', 1);
    body += docParagraph('数据库脚本清单用于记录本次投产所有 DDL、DML、存储过程、索引、配置数据等脚本。脚本必须经过测试环境验证，并准备对应回退脚本或数据恢复方案。相同数据库的脚本已放在一起，执行时按清单顺序逐个执行。');
    const sqlRows = [['序号', '脚本名称', '执行库']];
    orderedSqls.forEach((item, i) => {
        const db = sqlDbName(item);
        sqlRows.push([String(i + 1), db + (item.req.name || '') + '.sql', db]);
    });
    if (sqlRows.length === 1) sqlRows.push(['1', '无', '']);
    body += docTable(sqlRows, [0.55, 5.3, 1.25]);
    body += docHeading('脚本管理要求', 2);
    body += docParagraph('1. 脚本需按执行顺序编号，例如 01_xxx.sql、02_xxx.sql，禁止投产现场临时调整顺序。');
    body += docParagraph('2. DML 类脚本需明确影响数据范围、影响行数预估、执行后校验 SQL 及回退 SQL。');
    body += docParagraph('3. DDL 类脚本需确认表空间、索引、锁表风险及高峰期影响，必要时提前完成变更窗口评估。');

    body += docHeading('5. 新增API', 1);
    if (m.apis.length) {
        body += docParagraph('本次投产需要新增API。进入平台助手 21.2.51.91:8080，账户 admin，密码 sunline；进入网关助手，点击右侧菜单 API 市场，点击新增 API。');
        m.apis.forEach((item, i) => {
            const api = item.api || {};
            body += docHeading('5.' + (i + 1) + ' ' + (api.apiName || 'API'), 2);
            body += docTable([
                ['参数名称', '参数值'],
                ['API', api.apiName || ''],
                ['API分组', api.apiGroup || 'LTTS'],
                ['API版本', api.apiVersion || '1.0'],
                ['接入方式', api.accessMethod || 'REST接入'],
                ['接出模板', api.outTemplate || 'REST负载'],
                ['接出实例', api.outInstance || '无'],
                ['应用名', api.appName || 'app-comm-onl'],
                ['资源路径', api.resourcePath || (api.apiName ? '/' + api.apiName : '')],
                ['drs服务类型', api.drsServiceType || 'concentrated'],
                ['报文转换', api.messageTransform || '禁用']
            ]);
            body += docParagraph('点击确定后，搜索 ' + (api.apiName || '') + '，点击发布。进入 22.2.51.91:8080、22.2.53.91:8080 后重复新增和发布步骤。');
        });
    } else {
        body += docParagraph('本次投产无新增 API。');
    }

    body += docHeading('6. 数据库脚本执行步骤', 1);
    body += docHeading('6.1 执行前检查', 2);
    body += docParagraph('1. 确认数据库脚本清单与审批材料一致，脚本文件未被临时修改。');
    body += docParagraph('2. 确认脚本执行账户、目标数据库、目标 Schema、执行工具和字符集设置正确。');
    body += docParagraph('3. 确认数据库连接正常，数据库无异常告警，当前无阻塞投产的长事务或锁等待。');
    body += docParagraph('4. 确认已完成相关表、配置数据、存储过程或全库备份，备份可查询、可恢复。');
    body += docParagraph('5. 对 DML 脚本先执行影响范围查询，记录执行前数据量、关键字段值和预估影响行数。');
    body += docHeading('6.2 执行操作', 2);
    if (sqlGroups.length) {
        sqlGroups.forEach((group, i) => {
            const db = group.db;
            const applyUser = dbApplyUser(db);
            body += docHeading('6.2.' + (i + 1) + ' ' + db + '库脚本执行', 3);
            body += docParagraph('1. 选择婺城机房业务一区核心OB数据库OBS负载，申请 ' + applyUser + ' 用户会同后进入。');
            body += docParagraph('2. 进入 ob 客户端后，点击右上角账户-个人设置，将事务提交模式设置成手动。');
            body += docParagraph('3. 进入连接后，按以下脚本顺序逐个执行；每个脚本执行完成并完成校验后，再继续执行同库下一个脚本。');
            group.items.forEach((item, j) => {
                const sql = item.sql || {};
                const fileName = db + (item.req.name || '') + '.sql';
                const sqlContent = buildSqlDownloadContent(sql, item.req, db, sqlGeneratedAt);
                body += docHeading('6.2.' + (i + 1) + '.' + (j + 1) + ' ' + fileName, 4);
                body += docParagraph(sqlContent, 'Code');
            });
        });
    } else {
        body += docParagraph('本次投产无数据库脚本。');
    }
    body += docHeading('6.3 数据库脚本执行确认表', 2);
    const sqlConfirmRows = [['序号', '脚本', '执行结果']];
    orderedSqls.forEach((item, i) => {
        const db = sqlDbName(item);
        sqlConfirmRows.push([String(i + 1), db + (item.req.name || '') + '.sql', manualCell('□成功 □失败')]);
    });
    if (sqlConfirmRows.length === 1) sqlConfirmRows.push(['', '无', manualCell('□不适用')]);
    body += docTable(sqlConfirmRows, [0.55, 5.3, 1.25]);

    body += docHeading('7. 包上传及部署步骤', 1);
    body += docParagraph('本章节用于记录投产包上传、Jenkins 部署和部署后复核步骤。包上传步骤按投产窗口日期自动生成，包部署步骤按窗口中填写的内容带出。');
    body += docHeading('7.1 包上传步骤', 2);
    body += docParagraph('投产包通过摆渡上传至运维区，进入生产摆渡21.4.178.11下载投产包。包上传统一上传至生产服务器信创nexus：21.10.8.78:8081，账号admin，密码Ab123456。');
    body += docParagraph('1.进入nexus后，点击左侧upload菜单，进入cbs目录。');
    packageOptions.forEach((opt, i) => {
        body += docParagraph((i + 2) + '.上传' + opt.value + '包，directory命名为' + opt.packageName + '/' + uploadDate + '。', 'ManualText');
    });
    body += docParagraph((packageOptions.length + 2) + '. 返回进入左侧browse菜单，进入cbs目录，查看' + packageNamesText + '在' + uploadDate + '下是否成功上传。', 'ManualText');
    body += docHeading('7.2 包部署步骤', 2);
    body += docParagraph(jenkinsAccessText);
    body += docParagraph(deployStepsText, 'ManualText');
    body += docHeading('7.3 ' + dateCode + '投产复核表', 2);
    body += docTable([
        ['本次上线', '金东非信创', '复核'],
        ['', 'Cm-dist-1', manualCell('')],
        ['', 'Cm-dist-2', manualCell('')],
        ['', 'Core-dist-1', manualCell('')],
        ['', 'Core-dist-2', manualCell('')],
        ['', 'gl-dist-1', manualCell('')],
        ['', 'gl-dist-2', manualCell('')],
        ['本次上线', '金东信创', '复核'],
        ['', 'Cm-dist-1', manualCell('')],
        ['', 'Cm-dist-2', manualCell('')],
        ['', 'Core-dist-1', manualCell('')],
        ['', 'Core-dist-2', manualCell('')],
        ['本次上线', '婺城', '复核'],
        ['', 'Cm-dist-1', manualCell('')],
        ['', 'Cm-dist-2', manualCell('')],
        ['', 'Core-dist-1', manualCell('')],
        ['', 'Core-dist-2', manualCell('')]
    ]);

    body += docHeading('8. 回退方案', 1);
    body += docParagraph('回退方案用于在投产失败、验证不通过或出现重大异常时恢复至投产前状态。回退操作必须由投产负责人统一决策，应用部署负责人、数据库负责人、业务验证负责人协同执行。');
    body += docHeading('8.1 回退触发条件', 2);
    body += docParagraph('1. 投产包部署失败，且无法在变更窗口内完成修复。');
    body += docParagraph('2. 服务启动失败、核心交易不可用、关键接口不可用或批量任务无法恢复。');
    body += docParagraph('3. 数据库脚本执行失败，且影响范围不明确或存在数据一致性风险。');
    body += docParagraph('4. 业务验证不通过，且问题影响核心业务办理或账务处理。');
    body += docParagraph('5. 生产监控出现重大异常，包括持续交易失败、系统资源异常、数据库严重锁等待或大量报错。');
    body += docHeading('8.2 应用包回退步骤', 2);
    body += docParagraph('1. 投产负责人宣布启动回退，记录回退启动时间和触发原因。');
    body += docParagraph('2. 停止 gl、cm、core 相关服务或再次切流，确保回退期间无新增交易进入相关节点。');
    body += docParagraph('3. 备份当前失败版本目录，保留问题分析现场。');
    body += docParagraph('4. 恢复 gl、cm、core 原版本包及原配置文件。');
    body += docParagraph('5. 检查恢复后目录权限、文件完整性和启动脚本。');
    body += docParagraph('6. 启动服务或恢复流量，执行技术验证和业务验证。');
    body += docParagraph('7. 回退完成后记录回退结束时间、验证结果和待分析问题。');
    body += docHeading('8.3 回退后验证', 2);
    body += docTable([
        ['序号', '检查项', '标准/要求', '结果', '确认人'],
        ['1', '服务状态', '回退后 gl、cm、core 相关服务启动正常。', manualCell('□通过 □不通过 □不适用'), manualCell('')],
        ['2', '交易验证', '核心查询、账务、接口或本次相关交易恢复正常。', manualCell('□通过 □不通过 □不适用'), manualCell('')],
        ['3', '数据库状态', '对象状态正常，关键表数据和配置恢复正常。', manualCell('□通过 □不通过 □不适用'), manualCell('')],
        ['4', '日志检查', '回退后无新增严重报错或连续异常。', manualCell('□通过 □不通过 □不适用'), manualCell('')],
        ['5', '监控检查', '系统资源、交易成功率、接口成功率恢复至正常水平。', manualCell('□通过 □不通过 □不适用'), manualCell('')],
        ['6', '业务确认', '业务部门确认可恢复正常办理。', manualCell('□通过 □不通过 □不适用'), manualCell('')]
    ]);

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:body>' + body
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
        + '</w:body></w:document>';
}

function buildDocxStylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/></w:rPr><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="360" w:after="360"/></w:pPr><w:rPr><w:b/><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="36"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="360" w:after="180"/></w:pPr><w:rPr><w:b/><w:color w:val="1D4ED8"/><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="28"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="24"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="180" w:after="100"/></w:pPr><w:rPr><w:b/><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="140" w:after="80"/></w:pPr><w:rPr><w:b/><w:color w:val="334155"/><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="260" w:lineRule="auto"/><w:shd w:fill="F3F4F6"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="18"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="ManualText"><w:name w:val="ManualText"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="160" w:line="300" w:lineRule="auto"/><w:shd w:fill="' + MANUAL_FILL + '"/></w:pPr><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/></w:rPr></w:style>'
        + '<w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="TableHeader"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="20"/></w:rPr></w:style>'
        + '</w:styles>';
}

function buildDocxPackage(win) {
    const now = new Date().toISOString();
    const documentXml = buildManualDocumentXml(win);
    const files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
        'word/_rels/document.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'word/document.xml': documentXml,
        'word/styles.xml': buildDocxStylesXml(),
        'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>金华银行核心投产手册' + xmlEscape(win.date || '') + '</dc:title><dc:creator>deploy-manager</dc:creator><cp:lastModifiedBy>deploy-manager</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>',
        'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>deploy-manager</Application></Properties>'
    };
    return createZipBuffer(Object.keys(files).map(name => ({ name, data: files[name] })));
}

function excelColumnName(index) {
    let name = '';
    let n = index;
    while (n > 0) {
        const mod = (n - 1) % 26;
        name = String.fromCharCode(65 + mod) + name;
        n = Math.floor((n - 1) / 26);
    }
    return name;
}

function xlsxCell(rowIndex, colIndex, value, styleId) {
    const ref = excelColumnName(colIndex) + rowIndex;
    const style = styleId ? ' s="' + styleId + '"' : '';
    return '<c r="' + ref + '" t="inlineStr"' + style + '><is><t xml:space="preserve">' + xmlEscape(value) + '</t></is></c>';
}

function buildRequirementsSheetXml(win) {
    const headers = ['序号', '需求名称', '需求编号', '解决人', '业务人员'];
    const reqs = (win.requirements || []).filter(r => (r.status || 'normal') !== 'delayed');
    const rows = [headers].concat(reqs.map((req, i) => [
        String(i + 1),
        req.name || '',
        req.number || '',
        req.resolver || '',
        req.businessPerson || ''
    ]));
    const sheetRows = rows.map((row, ri) => {
        const rowIndex = ri + 1;
        return '<row r="' + rowIndex + '">' + row.map((value, ci) => xlsxCell(rowIndex, ci + 1, value, ri === 0 ? 1 : 0)).join('') + '</row>';
    }).join('');
    const lastRow = Math.max(rows.length, 1);
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        + '<cols><col min="1" max="1" width="8" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/><col min="3" max="3" width="20" customWidth="1"/><col min="4" max="4" width="16" customWidth="1"/><col min="5" max="5" width="16" customWidth="1"/></cols>'
        + '<sheetData>' + sheetRows + '</sheetData>'
        + '<autoFilter ref="A1:E' + lastRow + '"/>'
        + '</worksheet>';
}

function buildRequirementsXlsxPackage(win) {
    const now = new Date().toISOString();
    const files = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="需求清单" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': buildRequirementsSheetXml(win),
        'xl/styles.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D4ED8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD9E2EF"/></left><right style="thin"><color rgb="FFD9E2EF"/></right><top style="thin"><color rgb="FFD9E2EF"/></top><bottom style="thin"><color rgb="FFD9E2EF"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>',
        'docProps/core.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>投产需求清单' + xmlEscape(win.date || '') + '</dc:title><dc:creator>deploy-manager</dc:creator><cp:lastModifiedBy>deploy-manager</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>',
        'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>deploy-manager</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>需求清单</vt:lpstr></vt:vector></TitlesOfParts></Properties>'
    };
    return createZipBuffer(Object.keys(files).map(name => ({ name, data: files[name] })));
}

const zipCrcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = zipCrcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createZipBuffer(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    files.forEach(file => {
        const nameBuf = Buffer.from(file.name, 'utf8');
        const dataBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
        const crc = crc32(dataBuf);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(0, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(dataBuf.length, 18);
        local.writeUInt32LE(dataBuf.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, nameBuf, dataBuf);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(dataBuf.length, 20);
        central.writeUInt32LE(dataBuf.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBuf);
        offset += local.length + nameBuf.length + dataBuf.length;
    });
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat(localParts.concat(centralParts).concat([end]));
}

const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url, 'http://localhost');

    // POST /api/login
    if (url.pathname === '/api/login' && req.method === 'POST') {
        readBody(req, body => {
            try {
                const { username, password } = JSON.parse(body);
                const users = readUsers().users;
                const loginName = String(username || 'admin').trim();
                const user = users.find(u => u.username === loginName);
                if (verifyPassword(user, password)) {
                    return json(res, 200, Object.assign({ ok: true }, issueSession(user)));
                }
                if (loginName === 'admin' && password === ADMIN_PASSWORD) {
                    return json(res, 200, Object.assign({ ok: true }, issueSession({ id: 'env_admin', username: 'admin', name: '管理员', role: 'admin' })));
                }
                json(res, 401, { ok: false, message: '用户名或密码错误' });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/me
    if (url.pathname === '/api/me' && req.method === 'GET') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '未登录' });
        return json(res, 200, { ok: true, user: sanitizeUser(session) });
    }

    // POST /api/me/password — 当前用户修改自己的密码
    if (url.pathname === '/api/me/password' && req.method === 'POST') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '未登录' });
        readBody(req, body => {
            try {
                const payload = JSON.parse(body);
                const oldPassword = String(payload.oldPassword || '');
                const newPassword = String(payload.newPassword || '');
                if (!oldPassword || !newPassword) return json(res, 400, { ok: false, message: '请填写原密码和新密码' });
                const store = readUsers();
                const users = store.users;
                const idx = users.findIndex(u => u.id === session.id || u.username === session.username);
                if (idx < 0) return json(res, 404, { ok: false, message: '当前用户不存在，请重新登录' });
                if (!verifyPassword(users[idx], oldPassword)) return json(res, 400, { ok: false, message: '原密码错误' });
                setUserPassword(users[idx], newPassword);
                writeUsers(store);
                return json(res, 200, { ok: true });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/users — 仅管理员
    if (url.pathname === '/api/users' && req.method === 'GET') {
        if (!checkAdmin(req)) return json(res, 403, { ok: false, message: '需要管理员权限' });
        return json(res, 200, { ok: true, users: readUsers().users.map(u => sanitizeUser(u, true)), roles: ROLES });
    }

    // POST /api/users — 仅管理员
    if (url.pathname === '/api/users' && req.method === 'POST') {
        const session = getSession(req);
        if (!session || session.role !== 'admin') return json(res, 403, { ok: false, message: '需要管理员权限' });
        readBody(req, body => {
            try {
                const payload = JSON.parse(body);
                const store = readUsers();
                const users = store.users;
                if (payload.action === 'delete') {
                    const id = String(payload.id || '');
                    const target = users.find(u => u.id === id);
                    if (!target) return json(res, 404, { ok: false, message: '用户不存在' });
                    if (target.id === session.id) return json(res, 400, { ok: false, message: '不能删除当前登录用户' });
                    if (target.role === 'admin' && adminCount(users) <= 1) return json(res, 400, { ok: false, message: '至少保留一个管理员' });
                    store.users = users.filter(u => u.id !== id);
                    writeUsers(store);
                    return json(res, 200, { ok: true, users: store.users.map(u => sanitizeUser(u, true)) });
                }

                const input = payload.user || {};
                const username = String(input.username || '').trim();
                const name = String(input.name || username).trim();
                const role = ROLES[input.role] ? input.role : '';
                if (!username) return json(res, 400, { ok: false, message: '请填写用户名' });
                if (!role) return json(res, 400, { ok: false, message: '请选择有效角色' });

                if (input.id) {
                    const idx = users.findIndex(u => u.id === input.id);
                    if (idx < 0) return json(res, 404, { ok: false, message: '用户不存在' });
                    if (users.some(u => u.id !== input.id && u.username === username)) return json(res, 400, { ok: false, message: '用户名已存在' });
                    const next = Object.assign({}, users[idx], { username, name, role, disabled: Boolean(input.disabled) });
                    if (users[idx].role === 'admin' && role !== 'admin' && adminCount(users) <= 1) return json(res, 400, { ok: false, message: '至少保留一个管理员' });
                    if (users[idx].role === 'admin' && next.disabled && adminCount(users) <= 1) return json(res, 400, { ok: false, message: '至少保留一个管理员' });
                    if (input.password) {
                        setUserPassword(next, input.password);
                    }
                    users[idx] = next;
                } else {
                    if (users.some(u => u.username === username)) return json(res, 400, { ok: false, message: '用户名已存在' });
                    if (!input.password) return json(res, 400, { ok: false, message: '新用户必须设置密码' });
                    users.push(createUserRecord({ username, name, role, password: input.password, disabled: Boolean(input.disabled) }));
                }

                writeUsers(store);
                return json(res, 200, { ok: true, users: store.users.map(u => sanitizeUser(u, true)) });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/data
    if (url.pathname === '/api/data' && req.method === 'GET') {
        return json(res, 200, readAll());
    }

    // GET /api/manual?windowId=xxx — 生成投产手册 DOCX
    if (url.pathname === '/api/manual' && req.method === 'GET') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '请先登录' });
        const windowId = url.searchParams.get('windowId') || '';
        const store = readAll();
        const win = (store.windows || []).find(w => w.id === windowId);
        if (!win) return json(res, 404, { ok: false, message: '投产窗口不存在' });
        try {
            const manualErrors = manualReadyErrors(win);
            if (manualErrors.length) {
                return json(res, 400, { ok: false, message: '生成投产手册前，请先编辑投产窗口：' + manualErrors.join('、') });
            }
            const filename = '金华银行核心投产手册' + (win.date || '') + '.docx';
            const buf = buildDocxPackage(win);
            res.writeHead(200, {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
                'Content-Length': buf.length
            });
            res.end(buf);
        } catch (e) {
            json(res, 500, { ok: false, message: '生成投产手册失败: ' + e.message });
        }
        return;
    }

    // GET /api/requirements-export?windowId=xxx — 导出投产窗口需求清单 XLSX
    if (url.pathname === '/api/requirements-export' && req.method === 'GET') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '请先登录' });
        const windowId = url.searchParams.get('windowId') || '';
        const store = readAll();
        const win = (store.windows || []).find(w => w.id === windowId);
        if (!win) return json(res, 404, { ok: false, message: '投产窗口不存在' });
        try {
            const filename = '投产需求清单' + (win.date || '') + '.xlsx';
            const buf = buildRequirementsXlsxPackage(win);
            res.writeHead(200, {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
                'Content-Length': buf.length
            });
            res.end(buf);
        } catch (e) {
            json(res, 500, { ok: false, message: '导出需求清单失败: ' + e.message });
        }
        return;
    }

    // POST /api/data
    if (url.pathname === '/api/data' && req.method === 'POST') {
        const session = getSession(req);
        if (!session) return json(res, 401, { ok: false, message: '请先登录' });
        readBody(req, body => {
            try {
                const incoming = JSON.parse(body);
                const current = readAll();
                if (incoming._version !== current._version) {
                    return json(res, 409, { ok: false, conflict: true, message: '数据已被他人修改，请刷新页面后重试', serverVersion: current._version });
                }
                const permission = canWriteData(session.role, current, incoming);
                if (!permission.ok) return json(res, 403, { ok: false, message: permission.message });
                incoming._version = current._version + 1;
                writeAll(incoming);
                json(res, 200, { ok: true, _version: incoming._version });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/git — 获取 Git 配置（所有用户可读）
    if (url.pathname === '/api/git' && req.method === 'GET') {
        const cfg = readGitConfig();
        return json(res, 200, sanitizeGitConfig(cfg));
    }

    // POST /api/git — 保存 Git 配置（仅管理员）
    if (url.pathname === '/api/git' && req.method === 'POST') {
        if (!checkAdmin(req)) { return json(res, 403, { ok: false, message: '需要管理员登录' }); }
        readBody(req, body => {
            try {
                const incoming = JSON.parse(body);
                writeGitConfig(mergeGitConfig(incoming, readGitConfig()));
                json(res, 200, { ok: true });
            } catch (e) {
                json(res, 400, { ok: false, message: e.message });
            }
        });
        return;
    }

    // GET /api/repos — 使用服务端 Token 获取项目列表，避免 Token 暴露到浏览器
    if (url.pathname === '/api/repos' && req.method === 'GET') {
        const cfg = readGitConfig();
        const provider = cfg.provider || 'github';
        const token = providerToken(cfg);
        if (!token) return json(res, 400, { ok: false, message: '未配置 Token' });

        if (provider === 'github') {
            const page = url.searchParams.get('page') || '1';
            const api = 'https://api.github.com/user/repos?per_page=100&page=' + encodeURIComponent(page) + '&sort=updated';
            requestJson(api, {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'deploy-manager'
            }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
            return;
        }

        const host = ((cfg.gitlab || {}).host || '').replace(/\/+$/, '');
        if (!host) return json(res, 400, { ok: false, message: '未配置 GitLab 地址' });
        const page = url.searchParams.get('page') || '1';
        requestJson(host + '/api/v4/projects?membership=true&per_page=100&page=' + encodeURIComponent(page), {
            'PRIVATE-TOKEN': token
        }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
        return;
    }

    // GET /api/branches?repo=owner/repo|projectId
    if (url.pathname === '/api/branches' && req.method === 'GET') {
        const cfg = readGitConfig();
        const provider = cfg.provider || 'github';
        const token = providerToken(cfg);
        const repo = url.searchParams.get('repo') || '';
        if (!token) return json(res, 400, { ok: false, message: '未配置 Token' });
        if (!repo) return json(res, 400, { ok: false, message: '缺少仓库参数' });

        if (provider === 'github') {
            const parts = repo.split('/');
            if (!parts[0] || !parts[1]) return json(res, 400, { ok: false, message: '仓库格式错误' });
            const api = 'https://api.github.com/repos/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) + '/branches?per_page=100';
            requestJson(api, {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'User-Agent': 'deploy-manager'
            }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
            return;
        }

        const host = ((cfg.gitlab || {}).host || '').replace(/\/+$/, '');
        if (!host) return json(res, 400, { ok: false, message: '未配置 GitLab 地址' });
        requestJson(host + '/api/v4/projects/' + encodeURIComponent(repo) + '/repository/branches?per_page=100', {
            'PRIVATE-TOKEN': token
        }, (err, data) => err ? json(res, err.status || 500, { ok: false, message: err.message }) : json(res, 200, data));
        return;
    }

    // 静态文件
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
});

server.listen(PORT, () => {
    const os = require('os');
    const ifaces = os.networkInterfaces();
    console.log('http://localhost:' + PORT);
    console.log('Admin password: ' + ADMIN_PASSWORD);
    Object.values(ifaces).forEach(i => i.forEach(d => {
        if (d.family === 'IPv4' && !d.internal) console.log('http://' + d.address + ':' + PORT);
    }));
});
