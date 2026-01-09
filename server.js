// ============ 足球盘口系统 - 服务器端 ============
// 版本: 2.0.0
// 功能: 用户注册、登录、邀请码管理
// 数据库: Neon PostgreSQL
// ==============================================

// ============ 导入依赖 ============
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');

// ============ 初始化应用 ============
const app = express();
const port = process.env.PORT || 3000;

// ============ 数据库连接配置（Neon专用） ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon要求SSL连接
  ssl: {
    require: true,
    rejectUnauthorized: false
  },
  // Neon优化设置
  max: 10,        // 免费版最大10个连接
  min: 2,         // 最小连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  application_name: 'football-betting-system'
});

// 数据库连接测试
pool.connect()
  .then((client) => {
    console.log('✅ PostgreSQL数据库连接成功');
    client.release();
  })
  .catch(err => {
    console.error('❌ 数据库连接失败:', {
      message: err.message,
      code: err.code
    });
    console.log('💡 请检查:');
    console.log('1. DATABASE_URL环境变量是否正确');
    console.log('2. Neon数据库是否正常运行');
    console.log('3. 网络连接是否正常');
  });

// ============ 一键修复Neon数据库JSON数据 ============
const fixNeonDatabase = async () => {
  console.log('🔧 正在检查并修复Neon数据库...');
  
  try {
    // 检查表是否存在
    const tablesExist = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'invitation_codes')
    `);
    
    console.log(`找到 ${tablesExist.rows.length} 个表`);
    
    // 如果表已存在，修复JSON数据
    if (tablesExist.rows.some(row => row.table_name === 'invitation_codes')) {
      const fixResult = await pool.query(`
        -- 修复invitation_codes表的used_by字段
        UPDATE invitation_codes 
        SET used_by = '[]'::jsonb 
        WHERE used_by IS NULL OR jsonb_typeof(used_by) != 'array';
        
        -- 确保有默认值
        ALTER TABLE invitation_codes 
        ALTER COLUMN used_by SET DEFAULT '[]'::jsonb;
      `);
      console.log(`✅ 数据库修复完成，影响行数: ${fixResult.rowCount || 0}`);
    }
    
    return true;
  } catch (error) {
    console.warn('⚠️ 数据库修复遇到小问题（不影响启动）:', error.message);
    return false;
  }
};

// ============ 初始化数据库表 ============
const initDatabase = async () => {
  try {
    console.log('📊 正在初始化数据库表...');
    
    // 1. 先运行修复
    await fixNeonDatabase();
    
    // 2. 创建用户表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100),
        password VARCHAR(255) NOT NULL,
        user_type VARCHAR(20) DEFAULT 'trial',
        trial_count INTEGER DEFAULT 0,
        max_trial_count INTEGER DEFAULT 18,
        trial_end_date TIMESTAMP,
        registration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT TRUE,
        reset_password_token VARCHAR(255),
        reset_password_expires TIMESTAMP,
        invited_by VARCHAR(50),
        invite_code_used VARCHAR(50),
        subscription_type VARCHAR(20),
        subscription_start_date TIMESTAMP,
        subscription_end_date TIMESTAMP,
        subscription_active BOOLEAN DEFAULT FALSE,
        settings JSONB DEFAULT '{"theme":"auto","notifications":true,"language":"zh-CN"}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 3. 创建邀请码表（重点修复）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invitation_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        created_by VARCHAR(50) NOT NULL,
        created_for VARCHAR(50),
        max_uses INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMP,
        used_by JSONB DEFAULT '[]'::jsonb,  -- 明确设置为JSONB数组
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 4. 创建记录表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS records (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        match_name VARCHAR(200) NOT NULL,
        handicap_type VARCHAR(10) NOT NULL,
        initial_handicap NUMERIC(5,2) NOT NULL,
        current_handicap NUMERIC(5,2) NOT NULL,
        initial_water NUMERIC(4,2) NOT NULL,
        current_water NUMERIC(4,2) NOT NULL,
        handicap_change NUMERIC(5,2) NOT NULL,
        water_change NUMERIC(4,2) NOT NULL,
        historical_record VARCHAR(10) NOT NULL,
        recommendation VARCHAR(50) NOT NULL,
        actual_result VARCHAR(10),
        analysis JSONB DEFAULT '{"probability":0,"confidence":0,"factors":[]}',
        is_synced BOOLEAN DEFAULT TRUE,
        device_id VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 5. 创建索引
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_user_type ON users(user_type);
      CREATE INDEX IF NOT EXISTS idx_records_user_id ON records(user_id);
      CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_invitation_codes_code ON invitation_codes(code);
      CREATE INDEX IF NOT EXISTS idx_invitation_codes_is_active ON invitation_codes(is_active);
    `);
    
    // 6. 创建默认管理员账户
    const adminCheck = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [process.env.ADMIN_USERNAME || 'admin']
    );
    
    if (adminCheck.rows.length === 0) {
      const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
      await pool.query(
        `INSERT INTO users (username, password, user_type, email, is_active) 
         VALUES ($1, $2, $3, $4, $5)`,
        [
          process.env.ADMIN_USERNAME || 'admin',
          hashedPassword,
          'admin',
          'admin@footballbetting.com',
          true
        ]
      );
      console.log('✅ 默认管理员账户已创建');
    }
    
    // 7. 创建测试邀请码（确保JSON格式正确）
    const testCodes = ['TEST123', 'TEST456', 'INVITE789'];
    for (const code of testCodes) {
      const codeCheck = await pool.query(
        'SELECT id FROM invitation_codes WHERE code = $1',
        [code]
      );
      
      if (codeCheck.rows.length === 0) {
        await pool.query(
          `INSERT INTO invitation_codes (code, created_by, is_active, expires_at, used_by) 
           VALUES ($1, $2, $3, $4, $5)`,
          [
            code, 
            'system', 
            true, 
            new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            '[]'  // 明确设置为空数组
          ]
        );
        console.log(`✅ 邀请码 ${code} 已创建`);
      }
    }
    
    console.log('🎉 数据库初始化完成');
    
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error.message);
    
    // 尝试部分修复
    if (error.message.includes('used_by')) {
      console.log('🛠️ 尝试修复used_by字段...');
      try {
        await pool.query(`
          ALTER TABLE invitation_codes 
          ALTER COLUMN used_by SET DEFAULT '[]'::jsonb;
          
          UPDATE invitation_codes 
          SET used_by = '[]'::jsonb 
          WHERE used_by IS NULL;
        `);
        console.log('✅ used_by字段修复成功');
      } catch (fixError) {
        console.error('❌ 修复失败:', fixError.message);
      }
    }
  }
};

// ============ 中间件配置 ============

// 安全头部
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS配置（允许GitHub Pages和Vercel）
const corsOptions = {
  origin: function (origin, callback) {
    // 允许的域名列表
    const allowedOrigins = [
      'https://lwnn00.github.io',
      'https://footballdream.vercel.app',
      'https://backenbsfootball.vercel.app',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];
    
    // 开发环境允许所有来源
    if (process.env.NODE_ENV !== 'production') {
      callback(null, true);
      return;
    }
    
    // 生产环境：检查是否在允许列表中
    if (!origin || allowedOrigins.includes(origin) || 
        origin.includes('github.io') || 
        origin.includes('vercel.app') || 
        origin.includes('localhost')) {
      callback(null, true);
    } else {
      console.log(`⚠️ CORS拒绝: ${origin}`);
      callback(new Error('不允许的跨域请求'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept'],
  credentials: true,
  maxAge: 86400,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// 请求体解析
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 请求日志
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

// ============ 认证中间件 ============

// 验证JWT令牌
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: '未提供认证令牌' 
      });
    }
    
    const decoded = jwt.verify(
      token, 
      process.env.JWT_SECRET || 'football-betting-secret-key-2024'
    );
    req.userId = decoded.userId;
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      error: '无效的认证令牌' 
    });
  }
};

// 验证管理员权限
const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ 
        success: false, 
        error: '未提供认证令牌' 
      });
    }
    
    const decoded = jwt.verify(
      token, 
      process.env.JWT_SECRET || 'football-betting-secret-key-2024'
    );
    req.userId = decoded.userId;
    
    // 检查是否为管理员
    const userResult = await pool.query(
      'SELECT user_type FROM users WHERE id = $1',
      [req.userId]
    );
    
    if (userResult.rows.length === 0 || userResult.rows[0].user_type !== 'admin') {
      return res.status(403).json({ 
        success: false, 
        error: '需要管理员权限' 
      });
    }
    
    next();
  } catch (error) {
    return res.status(403).json({ 
      success: false, 
      error: '无效的认证令牌' 
    });
  }
};

// ============ 工具函数 ============

// 生成JWT令牌
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || 'football-betting-secret-key-2024',
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
};

// 验证注册数据
const validateRegister = (req, res, next) => {
  const { username, password, invitationCode } = req.body;
  
  if (!username || username.length < 3) {
    return res.status(400).json({ 
      success: false, 
      error: '用户名至少需要3个字符' 
    });
  }
  
  if (!password || password.length < 6) {
    return res.status(400).json({ 
      success: false, 
      error: '密码至少需要6个字符' 
    });
  }
  
  if (!invitationCode) {
    return res.status(400).json({ 
      success: false, 
      error: '请提供邀请码' 
    });
  }
  
  next();
};

// ============ API路由 ============

// 1. 健康检查
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: '足球盘口系统API v2.0',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      register: 'POST /api/register',
      login: 'POST /api/login',
      test: 'GET /api/test',
      invitationCodes: 'GET /api/invitation-codes',
      userInfo: 'GET /api/user/info (需认证)'
    }
  });
});

// 2. API测试端点
app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API测试端点工作正常',
    timestamp: new Date().toISOString(),
    cors: {
      origin: req.headers.origin || 'none',
      allowed: true
    }
  });
});

// 3. 用户注册（核心功能）
app.post('/api/register', validateRegister, async (req, res) => {
  const { username, password, invitationCode } = req.body;
  
  console.log(`📝 注册请求: ${username}, 邀请码: ${invitationCode}`);
  
  try {
    // 3.1 检查用户名是否已存在
    const userExists = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    
    if (userExists.rows.length > 0) {
      return res.status(400).json({ 
        success: false, 
        error: '用户名已存在，请选择其他用户名' 
      });
    }
    
    // 3.2 验证邀请码
    const codeResult = await pool.query(
      'SELECT * FROM invitation_codes WHERE code = $1',
      [invitationCode]
    );
    
    if (codeResult.rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码无效，请检查邀请码是否正确' 
      });
    }
    
    const code = codeResult.rows[0];
    
    // 检查邀请码状态
    if (!code.is_active) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码已失效' 
      });
    }
    
    if (code.expires_at && new Date() > code.expires_at) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码已过期' 
      });
    }
    
    if (code.used_count >= code.max_uses) {
      return res.status(400).json({ 
        success: false, 
        error: '邀请码使用次数已达上限' 
      });
    }
    
    // 3.3 加密密码
    const hashedPassword = await bcrypt.hash(password, 12);
    
    // 3.4 创建用户
    const userResult = await pool.query(
      `INSERT INTO users 
       (username, password, user_type, invite_code_used, invited_by) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, username, user_type, registration_date`,
      [username, hashedPassword, 'registered', invitationCode, code.created_by]
    );
    
    const newUser = userResult.rows[0];
    
    // 3.5 更新邀请码使用记录（使用安全的JSON更新方法）
    const newUsage = {
      username: username,
      used_at: new Date().toISOString(),
      user_id: newUser.id
    };
    
    // 方法1：使用PostgreSQL的JSONB函数（最安全）
    const updateQuery = `
      UPDATE invitation_codes 
      SET 
        used_count = used_count + 1,
        used_by = COALESCE(
          CASE 
            WHEN jsonb_typeof(used_by) = 'array' THEN used_by
            ELSE '[]'::jsonb
          END,
          '[]'::jsonb
        ) || $1::jsonb,
        is_active = CASE WHEN used_count + 1 >= max_uses THEN false ELSE is_active END,
        updated_at = CURRENT_TIMESTAMP
      WHERE code = $2
    `;
    
    await pool.query(updateQuery, [JSON.stringify([newUsage]), invitationCode]);
    
    // 3.6 生成JWT令牌
    const token = generateToken(newUser.id);
    
    console.log(`✅ 用户注册成功: ${username} (ID: ${newUser.id})`);
    
    // 3.7 返回成功响应
    res.status(201).json({
      success: true,
      user: {
        id: newUser.id,
        username: newUser.username,
        userType: newUser.user_type,
        registrationDate: newUser.registration_date
      },
      token: token,
      message: '注册成功！欢迎使用足球盘口系统'
    });
    
  } catch (error) {
    console.error('❌ 注册过程中出错:', {
      message: error.message,
      code: error.code,
      detail: error.detail
    });
    
    // 根据错误类型返回适当的错误信息
    let errorMessage = '服务器内部错误，请稍后重试';
    let statusCode = 500;
    
    if (error.code === '23505') {
      errorMessage = '用户名或邀请码已存在';
      statusCode = 400;
    } else if (error.code === '23503') {
      errorMessage = '数据完整性错误';
      statusCode = 400;
    } else if (error.code === '22P02') {
      errorMessage = '数据格式错误，请重试';
      statusCode = 400;
    } else if (error.message.includes('JSON')) {
      errorMessage = '数据格式错误，正在自动修复...';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      success: false, 
      error: errorMessage,
      debug: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});
// 6. 获取用户历史记录（需认证）
app.get('/api/history', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const { page = 1, limit = 20, type } = req.query;
    
    console.log(`📜 获取用户历史记录: 用户ID=${userId}, 类型=${type || 'all'}`);
    
    // 构建查询条件
    let query = `
      SELECT r.*, u.username 
      FROM records r 
      LEFT JOIN users u ON r.user_id = u.id 
      WHERE r.user_id = $1
    `;
    let queryParams = [userId];
    
    // 按类型筛选
    if (type && ['asian', 'size'].includes(type)) {
      query += ' AND r.handicap_type = $2';
      queryParams.push(type);
    }
    
    // 添加排序和分页
    query += ` ORDER BY r.created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    
    const result = await pool.query(query, queryParams);
    
    // 获取总数
    let countQuery = 'SELECT COUNT(*) as total FROM records WHERE user_id = $1';
    let countParams = [userId];
    
    if (type && ['asian', 'size'].includes(type)) {
      countQuery += ' AND handicap_type = $2';
      countParams.push(type);
    }
    
    const countResult = await pool.query(countQuery, countParams);
    
    res.json({
      success: true,
      records: result.rows.map(record => ({
        id: record.id,
        match_name: record.match_name,
        handicap_type: record.handicap_type,
        initial_handicap: parseFloat(record.initial_handicap),
        current_handicap: parseFloat(record.current_handicap),
        initial_water: parseFloat(record.initial_water),
        current_water: parseFloat(record.current_water),
        handicap_change: parseFloat(record.handicap_change),
        water_change: parseFloat(record.water_change),
        historical_record: record.historical_record,
        recommendation: record.recommendation,
        actual_result: record.actual_result,
        analysis: record.analysis || {},
        created_at: record.created_at,
        updated_at: record.updated_at,
        username: record.username
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        pages: Math.ceil(countResult.rows[0].total / parseInt(limit))
      }
    });
    
  } catch (error) {
    console.error('❌ 获取历史记录出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取历史记录失败' 
    });
  }
});

// 7. 保存记录（需认证）
app.post('/api/records', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const record = req.body;
    
    console.log(`📝 保存记录: 用户ID=${userId}, 赛事=${record.match_name}`);
    
    // 验证必填字段
    const requiredFields = [
      'match_name', 'handicap_type', 'initial_handicap', 
      'current_handicap', 'initial_water', 'current_water',
      'handicap_change', 'water_change', 'historical_record', 'recommendation'
    ];
    
    for (const field of requiredFields) {
      if (!record[field] && record[field] !== 0) {
        return res.status(400).json({ 
          success: false, 
          error: `缺少必填字段: ${field}` 
        });
      }
    }
    
    // 检查用户是否可以保存记录
    const userResult = await pool.query(
      'SELECT user_type, trial_count, max_trial_count FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '用户不存在' 
      });
    }
    
    const user = userResult.rows[0];
    
    // 试用用户检查次数限制
    if (user.user_type === 'trial' && user.trial_count >= user.max_trial_count) {
      return res.status(403).json({ 
        success: false, 
        error: '试用次数已用完，请注册成为正式会员' 
      });
    }
    
    // 插入记录
    const result = await pool.query(
      `INSERT INTO records 
       (user_id, match_name, handicap_type, initial_handicap, current_handicap, 
        initial_water, current_water, handicap_change, water_change, 
        historical_record, recommendation, actual_result, analysis) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
       RETURNING id, created_at`,
      [
        userId,
        record.match_name,
        record.handicap_type,
        record.initial_handicap,
        record.current_handicap,
        record.initial_water,
        record.current_water,
        record.handicap_change,
        record.water_change,
        record.historical_record,
        record.recommendation,
        record.actual_result || null,
        record.analysis || { probability: 0, confidence: 0, factors: [] }
      ]
    );
    
    // 更新试用次数（如果是试用用户）
    if (user.user_type === 'trial') {
      await pool.query(
        'UPDATE users SET trial_count = trial_count + 1 WHERE id = $1',
        [userId]
      );
    }
    
    console.log(`✅ 记录保存成功: 记录ID=${result.rows[0].id}`);
    
    res.status(201).json({
      success: true,
      recordId: result.rows[0].id,
      created_at: result.rows[0].created_at,
      remainingTrial: user.user_type === 'trial' ? 
        Math.max(0, user.max_trial_count - user.trial_count - 1) : null,
      message: '记录保存成功'
    });
    
  } catch (error) {
    console.error('❌ 保存记录出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '保存记录失败' 
    });
  }
});

// 8. 更新记录实际结果（需认证）
app.put('/api/records/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req;
    const { actual_result } = req.body;
    
    console.log(`✏️ 更新记录: 记录ID=${id}, 实际结果=${actual_result}`);
    
    // 检查记录是否存在且属于该用户
    const recordCheck = await pool.query(
      'SELECT user_id FROM records WHERE id = $1',
      [id]
    );
    
    if (recordCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '记录不存在' 
      });
    }
    
    if (recordCheck.rows[0].user_id !== userId) {
      return res.status(403).json({ 
        success: false, 
        error: '无权修改此记录' 
      });
    }
    
    // 更新记录
    await pool.query(
      'UPDATE records SET actual_result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [actual_result, id]
    );
    
    console.log(`✅ 记录更新成功: 记录ID=${id}`);
    
    res.json({
      success: true,
      message: '记录更新成功'
    });
    
  } catch (error) {
    console.error('❌ 更新记录出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '更新记录失败' 
    });
  }
});

// 9. 删除记录（需认证）
app.delete('/api/records/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req;
    
    console.log(`🗑️ 删除记录: 记录ID=${id}`);
    
    // 检查记录是否存在且属于该用户
    const recordCheck = await pool.query(
      'SELECT user_id FROM records WHERE id = $1',
      [id]
    );
    
    if (recordCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '记录不存在' 
      });
    }
    
    if (recordCheck.rows[0].user_id !== userId) {
      return res.status(403).json({ 
        success: false, 
        error: '无权删除此记录' 
      });
    }
    
    // 删除记录
    await pool.query('DELETE FROM records WHERE id = $1', [id]);
    
    console.log(`✅ 记录删除成功: 记录ID=${id}`);
    
    res.json({
      success: true,
      message: '记录删除成功'
    });
    
  } catch (error) {
    console.error('❌ 删除记录出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '删除记录失败' 
    });
  }
});

// 10. 让球盘推荐
app.post('/api/recommend/asian', async (req, res) => {
  try {
    const data = req.body;
    
    console.log('🎯 计算让球盘推荐:', data.match_name || '未命名赛事');
    
    const { 
      match_name = '未命名赛事',
      initialHandicap, 
      currentHandicap, 
      initialWater, 
      currentWater, 
      historicalRecord 
    } = data;
    
    // 验证输入
    if (initialHandicap === undefined || currentHandicap === undefined ||
        initialWater === undefined || currentWater === undefined ||
        !historicalRecord) {
      return res.status(400).json({
        success: false,
        error: '缺少必要的输入参数'
      });
    }
    
    // 简单的推荐算法
    const handicapChange = parseFloat(currentHandicap) - parseFloat(initialHandicap);
    const waterChange = parseFloat(currentWater) - parseFloat(initialWater);
    
    let recommendation = '上盘';
    let details = '';
    let confidence = 75;
    let factors = [];
    
    // 决策逻辑
    if (handicapChange > 0 && waterChange > 0) {
      recommendation = '上盘';
      details = '盘口和水位同时上升，看好上盘';
      factors = ['盘口上升', '水位上升', '正向变化'];
      confidence = 85;
    } else if (handicapChange < 0 && waterChange < 0) {
      recommendation = '下盘';
      details = '盘口和水位同时下降，看好下盘';
      factors = ['盘口下降', '水位下降', '反向变化'];
      confidence = 80;
    } else if (parseFloat(currentWater) < 0.85) {
      recommendation = '上盘';
      details = '低水位支撑上盘';
      factors = ['低水位', '市场看好'];
      confidence = 75;
    } else if (historicalRecord === 'win') {
      recommendation = '上盘';
      details = '历史战绩支持上盘';
      factors = ['历史战绩', '心理优势'];
      confidence = 70;
    } else if (parseFloat(currentHandicap) >= 1.5) {
      recommendation = '上盘';
      details = '深盘支持上盘';
      factors = ['深盘', '实力差距'];
      confidence = 65;
    } else {
      recommendation = '下盘';
      details = '综合考虑推荐下盘';
      factors = ['平衡分析', '风险控制'];
      confidence = 60;
    }
    
    // 计算概率
    const probability = Math.min(95, Math.max(40, 
      50 + (handicapChange * 10) + (waterChange * 5) + 
      (historicalRecord === 'win' ? 15 : -10)
    ));
    
    console.log(`✅ 推荐完成: ${recommendation} (置信度: ${confidence}%)`);
    
    res.json({
      success: true,
      recommendation,
      details,
      analysis: {
        probability: Math.round(probability),
        confidence,
        factors,
        handicapChange: parseFloat(handicapChange.toFixed(2)),
        waterChange: parseFloat(waterChange.toFixed(2)),
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('❌ 推荐计算错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '推荐计算失败' 
    });
  }
});

// 11. 大小盘推荐
app.post('/api/recommend/size', async (req, res) => {
  try {
    const data = req.body;
    
    console.log('🎯 计算大小盘推荐:', data.match_name || '未命名赛事');
    
    const { 
      match_name = '未命名赛事',
      initialHandicap, 
      currentHandicap, 
      initialWater, 
      currentWater, 
      historicalRecord 
    } = data;
    
    // 验证输入
    if (initialHandicap === undefined || currentHandicap === undefined ||
        initialWater === undefined || currentWater === undefined ||
        !historicalRecord) {
      return res.status(400).json({
        success: false,
        error: '缺少必要的输入参数'
      });
    }
    
    // 简单的推荐算法
    const handicapChange = parseFloat(currentHandicap) - parseFloat(initialHandicap);
    const waterChange = parseFloat(currentWater) - parseFloat(initialWater);
    
    let recommendation = '大球';
    let details = '';
    let confidence = 70;
    let factors = [];
    
    // 决策逻辑
    if (handicapChange > 0 && waterChange > 0) {
      recommendation = '大球';
      details = '盘口和水位同时上升，看好大球';
      factors = ['盘口上升', '水位上升', '进攻倾向'];
      confidence = 80;
    } else if (handicapChange < 0 && waterChange < 0) {
      recommendation = '小球';
      details = '盘口和水位同时下降，看好小球';
      factors = ['盘口下降', '水位下降', '防守倾向'];
      confidence = 75;
    } else if (parseFloat(currentHandicap) > 2.5) {
      recommendation = '大球';
      details = '高盘口支撑大球';
      factors = ['高盘口', '进球预期'];
      confidence = 70;
    } else if (historicalRecord === 'win') {
      recommendation = '大球';
      details = '历史战绩支持大球';
      factors = ['历史战绩', '进攻传统'];
      confidence = 65;
    } else if (parseFloat(currentWater) < 0.80) {
      recommendation = '大球';
      details = '超低水位支撑大球';
      factors = ['超低水位', '市场预期'];
      confidence = 60;
    } else {
      recommendation = '小球';
      details = '综合考虑推荐小球';
      factors = ['平衡分析', '风险控制'];
      confidence = 55;
    }
    
    // 计算概率
    const probability = Math.min(95, Math.max(40, 
      50 + (handicapChange * 8) + (waterChange * 4) + 
      (historicalRecord === 'win' ? 12 : -8)
    ));
    
    console.log(`✅ 推荐完成: ${recommendation} (置信度: ${confidence}%)`);
    
    res.json({
      success: true,
      recommendation,
      details,
      analysis: {
        probability: Math.round(probability),
        confidence,
        factors,
        handicapChange: parseFloat(handicapChange.toFixed(2)),
        waterChange: parseFloat(waterChange.toFixed(2)),
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('❌ 推荐计算错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '推荐计算失败' 
    });
  }
});

// 12. 获取统计信息（需认证）
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    
    console.log(`📊 获取用户统计信息: 用户ID=${userId}`);
    
    // 获取总记录数
    const totalResult = await pool.query(
      'SELECT COUNT(*) as count FROM records WHERE user_id = $1',
      [userId]
    );
    
    // 获取胜率统计
    const winRateResult = await pool.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins
       FROM records 
       WHERE user_id = $1 AND actual_result IS NOT NULL`,
      [userId]
    );
    
    // 获取不同类型胜率
    const typeResult = await pool.query(
      `SELECT 
        handicap_type,
        COUNT(*) as total,
        SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins
       FROM records 
       WHERE user_id = $1 AND actual_result IS NOT NULL
       GROUP BY handicap_type`,
      [userId]
    );
    
    // 获取变化胜率
    const changeResult = await pool.query(
      `SELECT 
        SUM(CASE WHEN water_change > 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as water_up_wins,
        SUM(CASE WHEN water_change > 0 THEN 1 ELSE 0 END) as water_up_total,
        SUM(CASE WHEN water_change < 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as water_down_wins,
        SUM(CASE WHEN water_change < 0 THEN 1 ELSE 0 END) as water_down_total,
        SUM(CASE WHEN handicap_change > 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as handicap_up_wins,
        SUM(CASE WHEN handicap_change > 0 THEN 1 ELSE 0 END) as handicap_up_total,
        SUM(CASE WHEN handicap_change < 0 AND actual_result = 'win' THEN 1 ELSE 0 END) as handicap_down_wins,
        SUM(CASE WHEN handicap_change < 0 THEN 1 ELSE 0 END) as handicap_down_total,
        SUM(CASE WHEN current_water < 0.90 AND actual_result = 'win' THEN 1 ELSE 0 END) as low_water_wins,
        SUM(CASE WHEN current_water < 0.90 THEN 1 ELSE 0 END) as low_water_total
       FROM records 
       WHERE user_id = $1 AND actual_result IS NOT NULL`,
      [userId]
    );
    
    const total = parseInt(totalResult.rows[0].count);
    const winRate = winRateResult.rows[0].total > 0 ? 
      Math.round((winRateResult.rows[0].wins / winRateResult.rows[0].total) * 100) : 0;
    
    const typeStats = {};
    typeResult.rows.forEach(row => {
      typeStats[row.handicap_type] = row.total > 0 ? 
        Math.round((row.wins / row.total) * 100) : 0;
    });
    
    const changeData = changeResult.rows[0];
    
    console.log(`✅ 统计信息获取完成: 总记录=${total}, 胜率=${winRate}%`);
    
    res.json({
      success: true,
      stats: {
        totalRecords: total,
        winRate: winRate,
        asianWinRate: typeStats.asian || 0,
        sizeWinRate: typeStats.size || 0,
        waterUpWinRate: changeData.water_up_total > 0 ? 
          Math.round((changeData.water_up_wins / changeData.water_up_total) * 100) : 0,
        waterDownWinRate: changeData.water_down_total > 0 ? 
          Math.round((changeData.water_down_wins / changeData.water_down_total) * 100) : 0,
        handicapUpWinRate: changeData.handicap_up_total > 0 ? 
          Math.round((changeData.handicap_up_wins / changeData.handicap_up_total) * 100) : 0,
        handicapDownWinRate: changeData.handicap_down_total > 0 ? 
          Math.round((changeData.handicap_down_wins / changeData.handicap_down_total) * 100) : 0,
        lowWaterWinRate: changeData.low_water_total > 0 ? 
          Math.round((changeData.low_water_wins / changeData.low_water_total) * 100) : 0
      }
    });
    
  } catch (error) {
    console.error('❌ 获取统计信息出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取统计信息失败' 
    });
  }
});

// 13. 同步本地数据（需认证）
app.post('/api/sync', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const { records = [] } = req.body;
    
    console.log(`🔄 同步数据: 用户ID=${userId}, 记录数=${records.length}`);
    
    const synced = [];
    const errors = [];
    
    for (const record of records) {
      try {
        // 检查是否已存在（通过设备ID或时间戳）
        const existing = await pool.query(
          'SELECT id FROM records WHERE user_id = $1 AND device_id = $2',
          [userId, record.deviceId]
        );
        
        if (existing.rows.length === 0) {
          // 插入新记录
          const result = await pool.query(
            `INSERT INTO records 
             (user_id, match_name, handicap_type, initial_handicap, current_handicap, 
              initial_water, current_water, handicap_change, water_change, 
              historical_record, recommendation, actual_result, device_id, is_synced) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true) 
             RETURNING id`,
            [
              userId,
              record.match_name,
              record.handicap_type,
              record.initial_handicap,
              record.current_handicap,
              record.initial_water,
              record.current_water,
              record.handicap_change,
              record.water_change,
              record.historical_record,
              record.recommendation,
              record.actual_result || '',
              record.deviceId || 'local'
            ]
          );
          
          synced.push({ id: result.rows[0].id, deviceId: record.deviceId });
        } else {
          // 更新现有记录
          await pool.query(
            `UPDATE records SET 
              match_name = $1, handicap_type = $2, initial_handicap = $3, current_handicap = $4,
              initial_water = $5, current_water = $6, handicap_change = $7, water_change = $8,
              historical_record = $9, recommendation = $10, actual_result = $11, is_synced = true,
              updated_at = CURRENT_TIMESTAMP
             WHERE id = $12`,
            [
              record.match_name,
              record.handicap_type,
              record.initial_handicap,
              record.current_handicap,
              record.initial_water,
              record.current_water,
              record.handicap_change,
              record.water_change,
              record.historical_record,
              record.recommendation,
              record.actual_result || '',
              existing.rows[0].id
            ]
          );
          
          synced.push({ id: existing.rows[0].id, deviceId: record.deviceId });
        }
      } catch (error) {
        errors.push({ deviceId: record.deviceId, error: error.message });
        console.error(`同步记录失败: ${record.deviceId}`, error);
      }
    }
    
    console.log(`✅ 同步完成: 成功=${synced.length}, 失败=${errors.length}`);
    
    res.json({
      success: true,
      synced,
      errors,
      message: `成功同步 ${synced.length} 条记录`
    });
    
  } catch (error) {
    console.error('❌ 同步数据出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '同步数据失败' 
    });
  }
});

// 14. 获取所有用户的记录（管理员功能）
app.get('/api/admin/records', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, username, type, startDate, endDate } = req.query;
    
    console.log('👨‍💼 管理员获取所有记录');
    
    let query = `
      SELECT r.*, u.username 
      FROM records r 
      JOIN users u ON r.user_id = u.id 
      WHERE 1=1
    `;
    let queryParams = [];
    
    // 按用户名筛选
    if (username) {
      query += ' AND u.username ILIKE $' + (queryParams.length + 1);
      queryParams.push(`%${username}%`);
    }
    
    // 按类型筛选
    if (type && ['asian', 'size'].includes(type)) {
      query += ' AND r.handicap_type = $' + (queryParams.length + 1);
      queryParams.push(type);
    }
    
    // 按日期筛选
    if (startDate) {
      query += ' AND r.created_at >= $' + (queryParams.length + 1);
      queryParams.push(startDate);
    }
    
    if (endDate) {
      query += ' AND r.created_at <= $' + (queryParams.length + 1);
      queryParams.push(endDate);
    }
    
    // 添加排序和分页
    query += ` ORDER BY r.created_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    
    const result = await pool.query(query, queryParams);
    
    // 获取总数
    let countQuery = `
      SELECT COUNT(*) as total 
      FROM records r 
      JOIN users u ON r.user_id = u.id 
      WHERE 1=1
    `;
    let countParams = [];
    
    // 同样的筛选条件
    if (username) {
      countQuery += ' AND u.username ILIKE $' + (countParams.length + 1);
      countParams.push(`%${username}%`);
    }
    
    if (type && ['asian', 'size'].includes(type)) {
      countQuery += ' AND r.handicap_type = $' + (countParams.length + 1);
      countParams.push(type);
    }
    
    if (startDate) {
      countQuery += ' AND r.created_at >= $' + (countParams.length + 1);
      countParams.push(startDate);
    }
    
    if (endDate) {
      countQuery += ' AND r.created_at <= $' + (countParams.length + 1);
      countParams.push(endDate);
    }
    
    const countResult = await pool.query(countQuery, countParams);
    
    res.json({
      success: true,
      records: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: parseInt(countResult.rows[0].total),
        pages: Math.ceil(countResult.rows[0].total / parseInt(limit))
      }
    });
    
  } catch (error) {
    console.error('❌ 管理员获取记录出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取记录失败' 
    });
  }
});
// 4. 用户登录
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  
  console.log(`🔑 登录请求: ${username}`);
  
  if (!username || !password) {
    return res.status(400).json({ 
      success: false, 
      error: '用户名和密码不能为空' 
    });
  }
  
  try {
    // 4.1 查找用户
    const userResult = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(401).json({ 
        success: false, 
        error: '用户名或密码错误' 
      });
    }
    
    const user = userResult.rows[0];
    
    // 4.2 验证密码
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ 
        success: false, 
        error: '用户名或密码错误' 
      });
    }
    
    // 4.3 检查用户状态
    if (!user.is_active) {
      return res.status(403).json({ 
        success: false, 
        error: '账户已被禁用，请联系管理员' 
      });
    }
    
    // 4.4 更新最后登录时间
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    // 4.5 生成JWT令牌
    const token = generateToken(user.id);
    
    console.log(`✅ 用户登录成功: ${username}`);
    
    // 4.6 返回用户信息和令牌
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        userType: user.user_type,
        trialCount: user.trial_count,
        maxTrialCount: user.max_trial_count,
        trialEndDate: user.trial_end_date,
        registrationDate: user.registration_date,
        lastLogin: user.last_login
      },
      token: token,
      message: '登录成功'
    });
    
  } catch (error) {
    console.error('❌ 登录过程中出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误，请稍后重试' 
    });
  }
});

// 5. 获取邀请码列表（公开）
app.get('/api/invitation-codes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT code, created_by, created_at, 
             is_active, used_count, max_uses, 
             expires_at, 
             CASE 
               WHEN jsonb_typeof(used_by) = 'array' THEN used_by
               ELSE '[]'::jsonb
             END as used_by
      FROM invitation_codes 
      WHERE is_active = true 
      ORDER BY created_at DESC
      LIMIT 50
    `);
    
    res.json({
      success: true,
      count: result.rows.length,
      codes: result.rows.map(row => ({
        code: row.code,
        created_by: row.created_by,
        created_at: row.created_at,
        is_active: row.is_active,
        used_count: row.used_count,
        max_uses: row.max_uses,
        expires_at: row.expires_at,
        used_by: row.used_by || [],
        remaining_uses: Math.max(0, row.max_uses - row.used_count)
      }))
    });
    
  } catch (error) {
    console.error('❌ 获取邀请码列表出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取邀请码列表失败' 
    });
  }
});

// 6. 导入邀请码（管理员功能）
app.post('/api/admin/invitation-codes', authenticateAdmin, async (req, res) => {
  try {
    const { codes, createdBy = 'admin', maxUses = 1 } = req.body;
    
    if (!Array.isArray(codes) || codes.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: '请提供有效的邀请码数组' 
      });
    }
    
    const inserted = [];
    const errors = [];
    
    for (const code of codes) {
      try {
        // 检查是否已存在
        const existing = await pool.query(
          'SELECT id FROM invitation_codes WHERE code = $1',
          [code.trim()]
        );
        
        if (existing.rows.length === 0) {
          await pool.query(
            `INSERT INTO invitation_codes 
             (code, created_by, is_active, max_uses, used_by) 
             VALUES ($1, $2, $3, $4, $5)`,
            [code.trim(), createdBy, true, maxUses, '[]']
          );
          inserted.push(code.trim());
          console.log(`✅ 导入邀请码: ${code.trim()}`);
        } else {
          errors.push(`${code}: 已存在`);
        }
      } catch (error) {
        errors.push(`${code}: ${error.message}`);
      }
    }
    
    res.json({
      success: true,
      inserted: inserted,
      errors: errors,
      message: `成功导入 ${inserted.length} 个邀请码，失败 ${errors.length} 个`
    });
    
  } catch (error) {
    console.error('❌ 导入邀请码出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '导入邀请码失败' 
    });
  }
});

// 7. 获取用户信息（需认证）
app.get('/api/user/info', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    
    const userResult = await pool.query(
      `SELECT id, username, user_type, trial_count, max_trial_count, 
              trial_end_date, registration_date, last_login,
              subscription_type, subscription_active, subscription_end_date,
              settings
       FROM users WHERE id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: '用户不存在' 
      });
    }
    
    const user = userResult.rows[0];
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        userType: user.user_type,
        trialCount: user.trial_count,
        maxTrialCount: user.max_trial_count,
        remainingTrialCount: Math.max(0, user.max_trial_count - user.trial_count),
        trialEndDate: user.trial_end_date,
        registrationDate: user.registration_date,
        lastLogin: user.last_login,
        subscription: {
          type: user.subscription_type,
          isActive: user.subscription_active,
          endDate: user.subscription_end_date
        },
        settings: user.settings
      }
    });
    
  } catch (error) {
    console.error('❌ 获取用户信息出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '获取用户信息失败' 
    });
  }
});

// 8. 重置试用次数（管理员功能）
app.post('/api/admin/reset-trial/:userId', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    await pool.query(
      'UPDATE users SET trial_count = 0 WHERE id = $1',
      [userId]
    );
    
    res.json({
      success: true,
      message: '试用次数已重置'
    });
    
  } catch (error) {
    console.error('❌ 重置试用次数出错:', error);
    res.status(500).json({ 
      success: false, 
      error: '重置试用次数失败' 
    });
  }
});

// 9. 数据库诊断端点（开发环境）
if (process.env.NODE_ENV !== 'production') {
  app.get('/api/diagnose', async (req, res) => {
    try {
      // 测试数据库连接
      const dbTest = await pool.query('SELECT NOW() as time, version() as version');
      
      // 检查表状态
      const tables = await pool.query(`
        SELECT table_name, 
               (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as columns,
               (SELECT count(*) FROM user_tables WHERE table_name = t.table_name) as row_count
        FROM information_schema.tables t
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      
      // 检查邀请码状态
      const codes = await pool.query(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN is_active THEN 1 ELSE 0 END) as active,
               SUM(used_count) as total_used,
               jsonb_typeof(used_by) as json_type
        FROM invitation_codes
      `);
      
      res.json({
        success: true,
        database: {
          connected: true,
          time: dbTest.rows[0].time,
          version: dbTest.rows[0].version.split(',')[0]
        },
        tables: tables.rows,
        invitationCodes: codes.rows[0],
        environment: process.env.NODE_ENV || 'development',
        serverTime: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('诊断出错:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
  
  // 快速修复端点
  app.post('/api/fix-json', async (req, res) => {
    try {
      const result = await pool.query(`
        UPDATE invitation_codes 
        SET used_by = '[]'::jsonb 
        WHERE used_by IS NULL OR jsonb_typeof(used_by) != 'array'
        RETURNING code, used_by
      `);
      
      res.json({
        success: true,
        fixed: result.rowCount,
        message: `已修复 ${result.rowCount} 个邀请码的JSON数据`
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

// 10. 数据库备份信息（仅信息展示）
app.get('/api/db-info', authenticateAdmin, async (req, res) => {
  try {
    const dbInfo = await pool.query(`
      SELECT 
        current_database() as name,
        current_user as user,
        inet_server_addr() as host,
        (SELECT count(*) FROM users) as user_count,
        (SELECT count(*) FROM invitation_codes) as code_count,
        (SELECT count(*) FROM records) as record_count,
        (SELECT count(*) FROM statistics) as stat_count
    `);
    
    res.json({
      success: true,
      info: dbInfo.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============ 错误处理 ============

// 404 - 未找到
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `未找到请求的资源: ${req.method} ${req.path}`,
    availableEndpoints: [
      'GET  /',
      'GET  /api/test',
      'POST /api/register',
      'POST /api/login',
      'GET  /api/invitation-codes'
    ]
  });
});

// 500 - 服务器错误
app.use((err, req, res, next) => {
  console.error('🔥 服务器错误:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  res.status(500).json({
    success: false,
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============ 启动服务器 ============
const startServer = async () => {
  try {
    console.log('🚀 启动足球盘口系统服务器...');
    console.log('📅 启动时间:', new Date().toISOString());
    console.log('🌍 环境:', process.env.NODE_ENV || 'development');
    console.log('🔗 CORS已配置，允许GitHub Pages和Vercel');
    
    // 初始化数据库
    await initDatabase();
    
    // 启动HTTP服务器
    const server = app.listen(port, () => {
      console.log(`✅ 服务器运行在端口 ${port}`);
      console.log(`📊 健康检查: http://localhost:${port}/`);
      console.log(`🔧 API测试: http://localhost:${port}/api/test`);
      
      if (process.env.NODE_ENV !== 'production') {
        console.log(`🛠️  诊断工具: http://localhost:${port}/api/diagnose`);
        console.log(`🔧 JSON修复: http://localhost:${port}/api/fix-json (POST)`);
      }
      
      console.log('\n📱 前端地址: https://lwnn00.github.io/footballdream');
      console.log('🎉 系统准备就绪，等待请求...');
    });
    
    // 优雅关闭
    process.on('SIGTERM', () => {
      console.log('收到SIGTERM信号，正在关闭服务器...');
      server.close(() => {
        console.log('服务器已关闭');
        pool.end();
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error('❌ 服务器启动失败:', {
      message: error.message,
      stack: error.stack
    });
    
    console.log('\n🔧 故障排除建议:');
    console.log('1. 检查DATABASE_URL环境变量是否正确');
    console.log('2. 检查Neon数据库连接状态');
    console.log('3. 检查端口是否被占用');
    console.log('4. 检查依赖是否安装完整');
    
    process.exit(1);
  }
};

// ============ 立即启动 ============
startServer();

// 导出app用于测试
module.exports = app;
