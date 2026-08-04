const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Supabase配置（从环境变量读取）
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_KEY);

let supabase = null;
if (USE_SUPABASE) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('Supabase 已启用');
} else {
  console.log('Supabase 未配置，使用本地文件存储');
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));

// CORS支持（允许浏览器跨域获取文件）
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ===== 本地文件存储（备用） =====
const DATA_DIR = path.join(__dirname, 'data');

// ===== 数据缓存 =====
let config = {
  password: '8888',
  mode: 'weight',
  maxDraws: 0,
  prizes: [
    { name: '一等奖', weight: 1 },
    { name: '二等奖', weight: 3 },
    { name: '三等奖', weight: 6 },
    { name: '完赛奖', weight: 8 },
    { name: '谢谢参与', weight: 10 }
  ]
};

let draws = [];
let codeIndex = new Map();
let userCounts = new Map();
let adminToken = null;
let configLoaded = false;

// ===== 初始化Supabase表 =====
async function initSupabase() {
  if (!supabase) return;

  try {
    // 检查config表是否存在数据
    const { data: cfgData } = await supabase
      .from('lottery_config')
      .select('*')
      .limit(1)
      .eq('id', 1);

    if (cfgData && cfgData.length > 0) {
      var row = cfgData[0];
      config = {
        password: row.password || '8888',
        mode: row.mode || 'weight',
        maxDraws: row.max_draws || 0,
        prizes: row.prizes || config.prizes
      };
      console.log('从Supabase加载配置成功');
    } else {
      // 插入默认配置
      await supabase.from('lottery_config').upsert({
        id: 1,
        password: config.password,
        mode: config.mode,
        max_draws: config.maxDraws,
        prizes: config.prizes
      });
      console.log('默认配置已写入Supabase');
    }

    // 加载所有抽奖记录到缓存
    const { data: drawData, error } = await supabase
      .from('lottery_draws')
      .select('*')
      .order('id', { ascending: true });

    if (error) throw error;

    if (drawData) {
      draws = drawData.map(function(row) {
        return {
          id: row.id,
          userId: row.user_id,
          prize: row.prize,
          code: row.code,
          status: row.status,
          time: row.draw_time,
          verifiedTime: row.verified_time || ''
        };
      });
      draws.forEach(function(d, i) {
        if (d.code) codeIndex.set(d.code, i);
        if (d.userId) userCounts.set(d.userId, (userCounts.get(d.userId) || 0) + 1);
      });
      console.log('从Supabase加载 ' + draws.length + ' 条抽奖记录');
    }

    configLoaded = true;
  } catch (e) {
    console.error('Supabase初始化失败:', e.message);
    console.log('回退到本地文件存储');
    loadLocalData();
  }
}

// ===== 本地数据加载（备用） =====
function loadLocalData() {
  try {
    const cfgPath = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(cfgPath)) {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    }
    const drawsPath = path.join(DATA_DIR, 'draws.json');
    if (fs.existsSync(drawsPath)) {
      draws = JSON.parse(fs.readFileSync(drawsPath, 'utf-8'));
      draws.forEach(function(d, i) {
        if (d.code) codeIndex.set(d.code, i);
        if (d.userId) userCounts.set(d.userId, (userCounts.get(d.userId) || 0) + 1);
      });
    }
    console.log('本地数据加载: ' + draws.length + ' 条记录');
  } catch (e) {
    console.error('本地数据加载失败:', e);
  }
  configLoaded = true;
}

function saveLocalData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(DATA_DIR, 'draws.json'), JSON.stringify(draws));
  } catch (e) {
    console.error('本地数据保存失败:', e);
  }
}

async function saveConfig() {
  if (supabase && configLoaded) {
    try {
      await supabase.from('lottery_config').upsert({
        id: 1,
        password: config.password,
        mode: config.mode,
        max_draws: config.maxDraws,
        prizes: config.prizes
      });
    } catch (e) {
      console.error('Supabase配置保存失败:', e);
      saveLocalData();
    }
  } else {
    saveLocalData();
  }
}

async function saveDraw(draw) {
  if (supabase && configLoaded) {
    try {
      const { data, error } = await supabase
        .from('lottery_draws')
        .insert({
          user_id: draw.userId,
          prize: draw.prize,
          code: draw.code,
          status: draw.status,
          draw_time: draw.time,
          verified_time: draw.verifiedTime
        })
        .select('id')
        .single();

      if (error) throw error;
      if (data) draw.id = data.id;
    } catch (e) {
      console.error('Supabase抽奖记录保存失败:', e);
    }
  } else {
    saveLocalData();
  }
}

async function updateDrawStatus(idx, status, verifiedTime) {
  if (supabase && configLoaded && draws[idx]) {
    try {
      await supabase
        .from('lottery_draws')
        .update({ status: status, verified_time: verifiedTime })
        .eq('code', draws[idx].code);
    } catch (e) {
      console.error('Supabase核销状态更新失败:', e);
    }
  }
  draws[idx].status = status;
  draws[idx].verifiedTime = verifiedTime;
  if (!supabase) saveLocalData();
}

async function resetAllData() {
  draws = [];
  codeIndex.clear();
  userCounts.clear();
  if (supabase && configLoaded) {
    try {
      await supabase.from('lottery_draws').delete().neq('id', 0);
    } catch (e) {
      console.error('Supabase重置失败:', e);
    }
  } else {
    saveLocalData();
  }
}

function generateCode() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var code;
  do {
    code = '';
    for (var i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (codeIndex.has(code));
  return code;
}

// ===== 启动时初始化 =====
async function startup() {
  if (USE_SUPABASE) {
    await initSupabase();
  } else {
    loadLocalData();
  }

  app.listen(PORT, function() {
    console.log('========================================');
    console.log('  抽奖服务器已启动');
    console.log('  访问地址: http://localhost:' + PORT);
    console.log('  管理密码: ' + config.password);
    console.log('  数据存储: ' + (USE_SUPABASE ? 'Supabase云数据库' : '本地文件'));
    console.log('========================================');
  });
}

// ===== API: 获取配置(公开) =====
app.get('/api/config', function(req, res) {
  var userId = req.query.userId;
  var myCount = userId ? (userCounts.get(userId) || 0) : 0;
  res.json({
    mode: config.mode,
    maxDraws: config.maxDraws,
    prizes: config.prizes,
    myDrawCount: myCount
  });
});

// ===== API: 抽奖 =====
app.post('/api/draw', async function(req, res) {
  var userId = req.body.userId;
  if (!userId) return res.status(400).json({ error: '缺少用户标识' });

  if (!config.prizes || config.prizes.length === 0) {
    return res.status(400).json({ error: '奖池为空，请联系管理员设置奖品' });
  }

  var myCount = userCounts.get(userId) || 0;
  if (config.maxDraws > 0 && myCount >= config.maxDraws) {
    return res.status(403).json({ error: '抽奖次数已用完' });
  }

  if (config.mode === 'quantity') {
    var hasStock = false;
    for (var i = 0; i < config.prizes.length; i++) {
      if (config.prizes[i].weight > 0) { hasStock = true; break; }
    }
    if (!hasStock) return res.status(400).json({ error: '奖品已抽完' });
  }

  var result = null;

  if (config.mode === 'quantity') {
    var available = config.prizes.filter(function(p) { return p.weight > 0; });
    var total = 0;
    available.forEach(function(p) { total += p.weight; });
    var r = Math.random() * total;
    var acc = 0;
    for (var i = 0; i < available.length; i++) {
      acc += available[i].weight;
      if (r < acc) {
        available[i].weight--;
        result = { name: available[i].name };
        await saveConfig();
        break;
      }
    }
  } else {
    var totalW = 0;
    config.prizes.forEach(function(p) { totalW += (p.weight || 0); });
    if (totalW <= 0) return res.status(400).json({ error: '权重配置有误' });
    var rw = Math.random() * totalW;
    var accW = 0;
    for (var i = 0; i < config.prizes.length; i++) {
      accW += (config.prizes[i].weight || 0);
      if (rw < accW) {
        result = { name: config.prizes[i].name };
        break;
      }
    }
  }

  if (!result) result = { name: config.prizes[config.prizes.length - 1].name };

  var code = generateCode();
  var now = new Date();
  var timeStr = (now.getMonth() + 1) + '/' + now.getDate() + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  var draw = {
    id: draws.length + 1,
    userId: userId,
    prize: result.name,
    code: code,
    status: 'pending',
    time: timeStr,
    verifiedTime: ''
  };

  draws.push(draw);
  codeIndex.set(code, draws.length - 1);
  userCounts.set(userId, myCount + 1);

  await saveDraw(draw);

  console.log('抽奖: 用户' + userId + ' -> ' + result.name + ' (核销码: ' + code + ')');
  res.json({ prize: result.name, code: code, time: timeStr });
});

// ===== API: 获取我的奖品 =====
app.get('/api/my-prizes', function(req, res) {
  var userId = req.query.userId;
  if (!userId) return res.json([]);
  res.json(draws.filter(function(d) { return d.userId === userId; }));
});

// ===== 管理员鉴权中间件 =====
function requireAdmin(req, res, next) {
  var token = req.headers.authorization;
  if (!adminToken || token !== adminToken) {
    return res.status(401).json({ error: '未授权，请重新登录' });
  }
  next();
}

// ===== API: 管理员登录 =====
app.post('/api/admin/login', function(req, res) {
  if (req.body.password === config.password) {
    adminToken = crypto.randomUUID();
    res.json({ token: adminToken, config: config });
  } else {
    res.status(401).json({ error: '密码错误' });
  }
});

// ===== API: 获取全部记录(管理员) =====
app.get('/api/admin/logs', requireAdmin, function(req, res) {
  res.json(draws);
});

// ===== API: 保存配置(管理员) =====
app.post('/api/admin/config', requireAdmin, async function(req, res) {
  var newConfig = req.body;
  if (!newConfig.prizes || !Array.isArray(newConfig.prizes)) {
    return res.status(400).json({ error: '配置格式有误' });
  }
  config = newConfig;
  await saveConfig();
  res.json({ ok: true });
});

// ===== API: 核销(管理员) =====
app.post('/api/admin/verify', requireAdmin, async function(req, res) {
  var code = (req.body.code || '').toUpperCase().trim();
  if (!code) return res.status(400).json({ error: '请输入核销码' });

  var idx = codeIndex.get(code);
  if (idx === undefined) return res.status(404).json({ error: '核销码不存在' });

  var draw = draws[idx];
  if (draw.status === 'verified') {
    return res.status(400).json({ error: '该奖品已核销', prize: draw.prize, code: draw.code });
  }

  var now = new Date();
  var verifiedTime = (now.getMonth() + 1) + '/' + now.getDate() + ' ' +
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  await updateDrawStatus(idx, 'verified', verifiedTime);

  console.log('核销: ' + code + ' -> ' + draw.prize);
  res.json({ ok: true, prize: draw.prize, code: draw.code });
});

// ===== API: 重置全部(管理员) =====
app.post('/api/admin/reset', requireAdmin, async function(req, res) {
  await resetAllData();
  console.log('管理员重置全部数据');
  res.json({ ok: true });
});

// ===== API: 健康检查 =====
app.get('/api/health', function(req, res) {
  res.json({
    status: 'ok',
    draws: draws.length,
    users: userCounts.size,
    storage: USE_SUPABASE ? 'supabase' : 'local'
  });
});

// ===== 静态文件服务 =====
app.use(express.static(__dirname, { index: 'lottery.html' }));

// 启动
startup();
