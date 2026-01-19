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

// ============ 表修复函数 ============
async function repairTableColumns() {
  console.log('🔧 开始检查并修复表结构...');
  
  const repairs = [
    {
      table: 'invitation_codes',
      column: 'notes',
      type: 'TEXT',
      description: '邀请码备注'
    },
    {
      table: 'invitation_codes',
      column: 'purpose',
      type: 'VARCHAR(100)',
      description: '邀请码用途'
    },
    {
      table: 'invitation_applications', 
      column: 'generated_code',
      type: 'VARCHAR(50)',
      description: '生成的邀请码'
    },
    {
      table: 'invitation_applications',
      column: 'reviewed_by',
      type: 'INTEGER',
      description: '审核人ID'
    },
    {
      table: 'invitation_applications',
      column: 'reviewed_at',
      type: 'TIMESTAMP',
      description: '审核时间'
    },
    {
      table: 'invitation_applications',
      column: 'review_notes',
      type: 'TEXT',
      description: '审核备注'
    }
  ];
  
  let repairedCount = 0;
  
  for (const repair of repairs) {
    try {
      // 检查列是否存在
      const checkResult = await pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = $1 AND column_name = $2
      `, [repair.table, repair.column]);
      
      if (checkResult.rows.length === 0) {
        // 列不存在，添加它
        await pool.query(`
          ALTER TABLE ${repair.table} 
          ADD COLUMN ${repair.column} ${repair.type}
        `);
        console.log(`✅ 已为 ${repair.table} 表添加 ${repair.column} 列 (${repair.description})`);
        repairedCount++;
      } else {
        console.log(`✅ ${repair.table} 表的 ${repair.column} 列已存在`);
      }
    } catch (error) {
      // 忽略"列已存在"的错误
      if (!error.message.includes('already exists') && !error.message.includes('duplicate column')) {
        console.error(`⚠️ 检查/修复 ${repair.table}.${repair.column} 时出错:`, error.message);
      }
    }
  }
  
  console.log(`🔧 表结构修复完成，修复了 ${repairedCount} 个缺失列`);
  return repairedCount;
}

// ============ 数据库连接 ============
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  
  // Neon优化设置
  max: process.env.NODE_ENV === 'production' ? 10 : 5,
  min: 1,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  allowExitOnIdle: false
});

// 添加连接池错误处理
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

pool.on('connect', () => {
  console.log('Database connection established');
});

pool.on('acquire', () => {
  console.log('Client checked out from pool');
});

// 测试数据库连接
pool.connect()
  .then(() => console.log('✅ Neon PostgreSQL数据库连接成功'))
  .catch(err => {
    console.error('❌ 数据库连接失败:', err);
    console.log('当前连接字符串:', process.env.DATABASE_URL ? '已设置' : '未设置');
  });

// ============ 初始化数据库表 ============
const initDatabase = async () => {
  try {
    console.log('📊 正在初始化数据库表...');
    
    // 用户表
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
    
    // 邀请码表 - 确保包含所有列
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invitation_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        created_by VARCHAR(50) NOT NULL,
        created_for VARCHAR(50),
        purpose VARCHAR(100),
        max_uses INTEGER DEFAULT 1,
        used_count INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        expires_at TIMESTAMP,
        used_by JSONB DEFAULT '[]',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // 记录表
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
    
    // 统计表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS statistics (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        month VARCHAR(7) NOT NULL,
        total_records INTEGER DEFAULT 0,
        win_rate NUMERIC(5,2) DEFAULT 0,
        asian_win_rate NUMERIC(5,2) DEFAULT 0,
        size_win_rate NUMERIC(5,2) DEFAULT 0,
        water_up_win_rate NUMERIC(5,2) DEFAULT 0,
        water_down_win_rate NUMERIC(5,2) DEFAULT 0,
        handicap_up_win_rate NUMERIC(5,2) DEFAULT 0,
        handicap_down_win_rate NUMERIC(5,2) DEFAULT 0,
        low_water_win_rate NUMERIC(5,2) DEFAULT 0,
        top_matches JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, month)
      )
    `);
    
    // 邀请码申请表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invitation_applications (
        id SERIAL PRIMARY KEY,
        application_id VARCHAR(50) UNIQUE NOT NULL,
        username VARCHAR(100) NOT NULL,
        email VARCHAR(200),
        purpose VARCHAR(50) NOT NULL,
        notes TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        review_notes TEXT,
        reviewed_by INTEGER REFERENCES users(id),
        reviewed_at TIMESTAMP,
        generated_code VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CHECK (status IN ('pending', 'completed', 'rejected'))
      )
    `);
    
    console.log('✅ 所有表创建完成');
    
    // 运行表修复
    const repairedCount = await repairTableColumns();
    
    if (repairedCount > 0) {
      console.log(`🔄 修复了 ${repairedCount} 个缺失的表列，正在重新检查表结构...`);
      
      // 检查关键列
      const criticalColumns = [
        { table: 'invitation_codes', column: 'notes' },
        { table: 'invitation_codes', column: 'purpose' },
        { table: 'invitation_applications', column: 'generated_code' }
      ];
      
      for (const col of criticalColumns) {
        const result = await pool.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = $1 AND column_name = $2
        `, [col.table, col.column]);
        
        if (result.rows.length > 0) {
          console.log(`✅ 确认 ${col.table}.${col.column} 列已存在`);
        } else {
          console.error(`❌ 严重错误: ${col.table}.${col.column} 列仍然缺失！`);
        }
      }
    }
    
    // 创建索引
    console.log('正在创建索引...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_user_type ON users(user_type);
      CREATE INDEX IF NOT EXISTS idx_records_user_id ON records(user_id);
      CREATE INDEX IF NOT EXISTS idx_records_created_at ON records(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_invitation_codes_code ON invitation_codes(code);
      CREATE INDEX IF NOT EXISTS idx_invitation_codes_is_active ON invitation_codes(is_active);
      CREATE INDEX IF NOT EXISTS idx_invitation_applications_status ON invitation_applications(status);
      CREATE INDEX IF NOT EXISTS idx_invitation_applications_created_at ON invitation_applications(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_invitation_applications_username ON invitation_applications(username);
      CREATE INDEX IF NOT EXISTS idx_invitation_applications_application_id ON invitation_applications(application_id);
    `);
    
    console.log('✅ 索引创建完成');
    
    // 创建默认管理员账户
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
    } else {
      console.log('✅ 管理员账户已存在');
    }
    
    // 创建一些测试邀请码
  //  const testCodes = ['TEST123', 'TEST456', 'INVITE789'];
   // let createdTestCodes = 0;
    
  //  for (const code of testCodes) {
   ////   const codeCheck = await pool.query(
      //  'SELECT id FROM invitation_codes WHERE code = $1',
    //    [code]
   //   );
      
    //  if (codeCheck.rows.length === 0) {
     //   await pool.query(
     //     `INSERT INTO invitation_codes (code, created_by, purpose, is_active, expires_at, notes) 
     //      VALUES ($1, $2, $3, $4, $5, $6)`,
     //     [
      //      code, 
            //'system',
      //      '测试邀请码',
       //     true, 
       //     new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        //    '系统生成的测试邀请码'
        //  ]
    //    );
//        createdTestCodes++;
//      }
//    }
    
//    if (createdTestCodes > 0) {
   //   console.log(`✅ 创建了 ${createdTestCodes} 个测试邀请码`);
 //   }
    
    console.log('🎉 数据库初始化完成');
    
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    console.error('错误详情:', error.message);
  }
};

// ============ CORS配置 ============
const corsOptions = {
  origin: function (origin, callback) {
    // 允许所有来源（开发环境）
    if (process.env.NODE_ENV !== 'production') {
      callback(null, true);
      return;
    }
    
    // 生产环境：只允许特定来源
    if (!origin) {
      callback(null, true);
    } else {
      const allowedOrigins = [
        'https://footballdream.vercel.app',
        'https://admindream.vercel.app',
        'https://lwnn00.github.io/admin/',
        'https://dream-lilac.vercel.app'
      ];
      
      if (allowedOrigins.includes(origin) || 
          origin.includes('vercel.app') ||
          origin.includes('localhost') ||
          origin.includes('127.0.0.1')) {
        callback(null, true);
      } else {
        console.log(`CORS拒绝: ${origin}`);
        callback(new Error('不允许的跨域请求'));
      }
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
    'X-API-Key',
    'X-Auth-Token'
  ],
  exposedHeaders: [
    'Content-Range', 
    'X-Content-Range',
    'X-Total-Count',
    'Link'
  ],
  credentials: true,
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors());

// ============ 中间件 ============
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: false
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

// ============ 认证中间件 ============
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ 
                success: false, 
                error: '需要认证令牌',
                code: 'MISSING_TOKEN'
            });
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || '0UdwoIzW/8IzdWSZLa+VP+nLKV1OQKNAOi2PbXMF+pA=');
        req.userId = decoded.userId;
        next();
    } catch (error) {
        console.error('[认证] 错误:', error.message);
        
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ 
                success: false, 
                error: '令牌已过期',
                code: 'TOKEN_EXPIRED'
            });
        }
        
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({ 
                success: false, 
                error: '无效的认证令牌',
                code: 'INVALID_TOKEN'
            });
        }
        
        return res.status(403).json({ 
            success: false, 
            error: '认证失败',
            code: 'AUTH_FAILED'
        });
    }
};

const authenticateAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, error: '未提供认证令牌' });
    }
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-super-secret-jwt-key');
    req.userId = decoded.userId;
    
    // 检查是否为管理员
    const userResult = await pool.query(
      'SELECT user_type FROM users WHERE id = $1',
      [req.userId]
    );
    
    if (userResult.rows.length === 0 || userResult.rows[0].user_type !== 'admin') {
      return res.status(403).json({ success: false, error: '需要管理员权限' });
    }
    
    next();
  } catch (error) {
    return res.status(403).json({ success: false, error: '无效的认证令牌' });
  }
};

// ============ 工具函数 ============
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || 'your-super-secret-jwt-key',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

const generateInvitationCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

const validateRegister = (req, res, next) => {
  const { username, password, invitationCode } = req.body;
  
  if (!username || username.length < 3) {
    return res.status(400).json({ success: false, error: '用户名至少需要3个字符' });
  }
  
  if (!password || password.length < 6) {
    return res.status(400).json({ success: false, error: '密码至少需要6个字符' });
  }
  
  if (!invitationCode) {
    return res.status(400).json({ success: false, error: '请提供邀请码' });
  }
  
  next();
};

// ============ API路由 ============

// 1. 健康检查
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: '足球盘口系统API正在运行',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/test', (req, res) => {
  res.json({ 
    success: true, 
    message: 'API测试端点正常工作',
    timestamp: new Date().toISOString()
  });
});

// ============ 用户注册（完全修复版） ============
app.post('/api/register', validateRegister, async (req, res) => {
  console.log('📝 用户注册请求:', { username: req.body.username, invitationCode: req.body.invitationCode });
  
  let client;
  
  try {
    const { username, password, invitationCode } = req.body;
    
    client = await pool.connect();
    await client.query('BEGIN');
    
    console.log(`🔍 检查用户名: ${username}`);
    const userExists = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    
    if (userExists.rows.length > 0) {
      await client.query('ROLLBACK');
      console.log(`❌ 用户名已存在: ${username}`);
      return res.status(400).json({ 
        success: false, 
        error: '用户名已存在' 
      });
    }
    
    console.log(`🔍 验证邀请码: ${invitationCode}`);
    const codeResult = await client.query(
      'SELECT * FROM invitation_codes WHERE code = $1 FOR UPDATE',
      [invitationCode.toUpperCase()]
    );
    
    if (codeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      console.log(`❌ 邀请码无效: ${invitationCode}`);
      return res.status(400).json({ 
        success: false, 
        error: '邀请码无效' 
      });
    }
    
    const code = codeResult.rows[0];
    
    console.log(`📊 邀请码详情:`, {
      code: code.code,
      is_active: code.is_active,
      used_count: code.used_count,
      max_uses: code.max_uses,
      expires_at: code.expires_at,
      used_by: code.used_by
    });
    
    if (!code.is_active) {
      await client.query('ROLLBACK');
      console.log(`❌ 邀请码已失效: ${invitationCode}`);
      return res.status(400).json({ 
        success: false, 
        error: '邀请码已失效' 
      });
    }
    
    if (code.expires_at && new Date() > new Date(code.expires_at)) {
      await client.query('ROLLBACK');
      console.log(`❌ 邀请码已过期: ${invitationCode}, 过期时间: ${code.expires_at}`);
      return res.status(400).json({ 
        success: false, 
        error: '邀请码已过期' 
      });
    }
    
    if (code.used_count >= code.max_uses) {
      await client.query('ROLLBACK');
      console.log(`❌ 邀请码使用次数已达上限: ${invitationCode}, 已使用 ${code.used_count}/${code.max_uses}`);
      return res.status(400).json({ 
        success: false, 
        error: '邀请码使用次数已达上限' 
      });
    }
    
    console.log(`🔐 加密密码...`);
    const hashedPassword = await bcrypt.hash(password, 12);
    
    console.log(`👤 创建用户: ${username}`);
    const userResult = await client.query(
      `INSERT INTO users 
       (username, password, user_type, invite_code_used, invited_by, email) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, username, user_type, registration_date`,
      [username, hashedPassword, 'registered', invitationCode, code.created_by, '']
    );
    
    const userId = userResult.rows[0].id;
    console.log(`✅ 用户创建成功, ID: ${userId}`);
    
    // 更新邀请码使用记录 - 修复JSON格式问题
    console.log(`📝 更新邀请码使用记录...`);
    try {
        // 处理used_by字段
        let usedByArray = [];
        
        // 检查used_by字段是否有效
        if (code.used_by) {
            if (Array.isArray(code.used_by)) {
                // 已经是数组，直接使用
                usedByArray = code.used_by;
            } else if (typeof code.used_by === 'string') {
                try {
                    // 尝试解析JSON字符串
                    const parsed = JSON.parse(code.used_by);
                    if (Array.isArray(parsed)) {
                        usedByArray = parsed;
                    }
                } catch (e) {
                    console.log('⚠️ used_by字段不是有效的JSON，重置为空数组');
                    usedByArray = [];
                }
            } else if (typeof code.used_by === 'object') {
                // 尝试转换为数组
                usedByArray = [code.used_by];
            }
        }
        
        // 添加新的使用记录
        usedByArray.push({
            username: username,
            used_at: new Date().toISOString(),
            user_id: userId
        });
        
        console.log(`📋 更新后的used_by:`, usedByArray);
        
        // 更新邀请码 - 使用JSON.stringify确保正确的JSON格式
        await client.query(
            `UPDATE invitation_codes 
             SET used_count = used_count + 1, 
                 used_by = $1::jsonb,
                 is_active = CASE WHEN used_count + 1 >= max_uses THEN false ELSE is_active END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE code = $2`,
            [JSON.stringify(usedByArray), invitationCode]
        );
        
        console.log(`✅ 邀请码使用记录更新成功`);
    } catch (updateError) {
        // 如果更新失败，尝试简单的方法
        console.log('⚠️ 标准更新失败，尝试简单更新...');
        try {
            // 只更新计数，不更新used_by字段
            await client.query(
                `UPDATE invitation_codes 
                 SET used_count = used_count + 1,
                     is_active = CASE WHEN used_count + 1 >= max_uses THEN false ELSE is_active END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE code = $1`,
                [invitationCode]
            );
            console.log(`✅ 邀请码使用计数更新成功（跳过used_by字段）`);
        } catch (simpleError) {
            await client.query('ROLLBACK');
            console.error('❌ 简单更新也失败:', simpleError);
            return res.status(500).json({ 
                success: false, 
                error: '更新邀请码记录失败',
                details: process.env.NODE_ENV === 'development' ? simpleError.message : undefined
            });
        }
    }
    
    // 提交事务
    await client.query('COMMIT');
    
    // 生成JWT令牌
    const token = generateToken(userResult.rows[0].id);
    
    console.log(`🎉 用户注册成功: ${username}, ID: ${userId}`);
    
    res.status(201).json({
      success: true,
      user: {
        id: userResult.rows[0].id,
        username: userResult.rows[0].username,
        userType: userResult.rows[0].user_type,
        registrationDate: userResult.rows[0].registration_date
      },
      token,
      message: '注册成功'
    });
    
  } catch (error) {
    console.error('❌ 注册错误:', error);
    
    // 回滚事务
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('回滚事务失败:', rollbackError);
      }
    }
    
    let errorMessage = '服务器内部错误';
    let statusCode = 500;
    
    if (error.code === '23505') {
      errorMessage = '用户名已存在';
      statusCode = 400;
    } else if (error.message.includes('violates foreign key constraint')) {
      errorMessage = '数据库约束错误';
    } else if (error.message.includes('JSON')) {
      errorMessage = '数据处理错误';
    }
    
    res.status(statusCode).json({ 
      success: false, 
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
    
  } finally {
    // 释放数据库连接
    if (client) {
      client.release();
    }
  }
});

// 3. 申请邀请码
app.post('/api/invitation/apply', async (req, res) => {
    try {
        console.log('📨 收到邀请码申请请求:', req.body);
        
        const { username, email, purpose, notes } = req.body;
        
        if (!username || !purpose) {
            return res.status(400).json({
                success: false,
                error: '用户名和使用目的是必填项'
            });
        }
        
        if (username.length < 2 || username.length > 50) {
            return res.status(400).json({
                success: false,
                error: '用户名长度应在2-50个字符之间'
            });
        }
        
        if (email) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({
                    success: false,
                    error: '邮箱格式不正确'
                });
            }
        }
        
        const recentApplication = await pool.query(
            `SELECT id, created_at FROM invitation_applications 
             WHERE username = $1 AND created_at > NOW() - INTERVAL '7 days'`,
            [username]
        );
        
        if (recentApplication.rows.length > 0) {
            return res.status(400).json({
                success: false,
                error: '该用户名在7天内已提交过申请'
            });
        }
        
        const applicationId = `APP${Date.now()}${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        
        const result = await pool.query(
            `INSERT INTO invitation_applications 
             (application_id, username, email, purpose, notes, status) 
             VALUES ($1, $2, $3, $4, $5, $6) 
             RETURNING id, application_id, username, email, purpose, notes, 
                       status, created_at`,
            [applicationId, username, email || null, purpose, notes || '', 'pending']
        );
        
        const application = result.rows[0];
        
        console.log(`✅ 申请已保存: ${applicationId} - ${username}`);
        
        res.status(201).json({
            success: true,
            message: '申请提交成功！请等待管理员审核。',
            application: {
                id: application.application_id,
                username: application.username,
                email: application.email,
                purpose: application.purpose,
                status: application.status,
                created_at: application.created_at
            }
        });
        
    } catch (error) {
        console.error('❌ 处理申请错误:', error);
        res.status(500).json({
            success: false,
            error: '服务器内部错误',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 4. 检查申请状态
app.get('/api/invitation/check/:applicationId', async (req, res) => {
    try {
        const { applicationId } = req.params;
        
        const result = await pool.query(
            `SELECT application_id, username, email, purpose, notes, 
                    status, review_notes, generated_code, reviewed_by, 
                    reviewed_at, created_at, updated_at
             FROM invitation_applications 
             WHERE application_id = $1`,
            [applicationId]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: '申请不存在'
            });
        }
        
        const application = result.rows[0];
        
        res.json({
            success: true,
            application: {
                id: application.application_id,
                username: application.username,
                email: application.email,
                purpose: application.purpose,
                status: application.status,
                review_notes: application.review_notes,
                generated_code: application.generated_code,
                created_at: application.created_at,
                reviewed_at: application.reviewed_at
            }
        });
        
    } catch (error) {
        console.error('获取申请状态错误:', error);
        res.status(500).json({
            success: false,
            error: '服务器内部错误'
        });
    }
});

// 5. 用户登录
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ 
        success: false, 
        error: '用户名和密码不能为空' 
      });
    }
    
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
    
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ 
        success: false, 
        error: '用户名或密码错误' 
      });
    }
    
    if (!user.is_active) {
      return res.status(403).json({ 
        success: false, 
        error: '账户已被禁用' 
      });
    }
    
    await pool.query(
      'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
      [user.id]
    );
    
    const token = generateToken(user.id);
    
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        userType: user.user_type,
        trialCount: user.trial_count,
        maxTrialCount: user.max_trial_count,
        trialEndDate: user.trial_end_date,
        subscription: {
          type: user.subscription_type,
          isActive: user.subscription_active
        }
      },
      token,
      message: '登录成功'
    });
    
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 6. 获取邀请码列表（修复版 - 处理缺失的purpose列）
app.get('/api/invitation-codes', async (req, res) => {
  try {
    console.log('🔍 获取邀请码列表...');
    
    // 首先检查表结构
    const tableCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'invitation_codes' AND column_name = 'purpose'
    `);
    
    let query;
    if (tableCheck.rows.length > 0) {
      // 表中有purpose列
      query = `
        SELECT code, created_by, created_at, 
               is_active, used_count, max_uses, 
               expires_at, used_by, notes, purpose
        FROM invitation_codes 
        WHERE is_active = true 
        ORDER BY created_at DESC
      `;
    } else {
      // 表中没有purpose列，使用默认值
      console.log('⚠️ invitation_codes表缺少purpose列，使用默认查询');
      query = `
        SELECT code, created_by, created_at, 
               is_active, used_count, max_uses, 
               expires_at, used_by, notes, 
               '系统生成' as purpose
        FROM invitation_codes 
        WHERE is_active = true 
        ORDER BY created_at DESC
      `;
    }
    
    const result = await pool.query(query);
    
    console.log(`✅ 获取到 ${result.rows.length} 个邀请码`);
    
    res.json({
      success: true,
      codes: result.rows.map(row => ({
        code: row.code,
        created_by: row.created_by,
        created_at: row.created_at,
        is_active: row.is_active,
        used_count: row.used_count,
        max_uses: row.max_uses,
        expires_at: row.expires_at,
        used_by: row.used_by || [],
        notes: row.notes,
        purpose: row.purpose || '系统生成'
      }))
    });
    
  } catch (error) {
    console.error('获取邀请码错误:', error);
    
    // 如果是列不存在的错误，尝试修复表结构
    if (error.message.includes('column "purpose" does not exist')) {
      console.log('尝试修复表结构...');
      try {
        await repairTableColumns();
        
        // 重新尝试查询
        const result = await pool.query(`
          SELECT code, created_by, created_at, 
                 is_active, used_count, max_uses, 
                 expires_at, used_by, notes, purpose
          FROM invitation_codes 
          WHERE is_active = true 
          ORDER BY created_at DESC
        `);
        
        res.json({
          success: true,
          codes: result.rows.map(row => ({
            code: row.code,
            created_by: row.created_by,
            created_at: row.created_at,
            is_active: row.is_active,
            used_count: row.used_count,
            max_uses: row.max_uses,
            expires_at: row.expires_at,
            used_by: row.used_by || [],
            notes: row.notes,
            purpose: row.purpose || '系统生成'
          }))
        });
        
      } catch (repairError) {
        console.error('修复表结构失败:', repairError);
        res.status(500).json({ 
          success: false, 
          error: '服务器内部错误，无法修复表结构' 
        });
      }
    } else {
      res.status(500).json({ 
        success: false, 
        error: '服务器内部错误' 
      });
    }
  }
});

// 7. 导入邀请码
app.post('/api/invitation-codes', authenticateAdmin, async (req, res) => {
  try {
    const { codes, createdBy = 'admin', purpose = '批量导入' } = req.body;
    
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
        const existing = await pool.query(
          'SELECT id FROM invitation_codes WHERE code = $1',
          [code]
        );
        
        if (existing.rows.length === 0) {
          await pool.query(
            `INSERT INTO invitation_codes (code, created_by, purpose, is_active, notes) 
             VALUES ($1, $2, $3, $4, $5)`,
            [code, createdBy, purpose, true, '批量导入']
          );
          inserted.push(code);
        } else {
          errors.push(`${code}: 已存在`);
        }
      } catch (error) {
        errors.push(`${code}: ${error.message}`);
      }
    }
    
    res.json({
      success: true,
      inserted,
      errors,
      message: `成功导入 ${inserted.length} 个邀请码`
    });
    
  } catch (error) {
    console.error('导入邀请码错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 8. 验证邀请码
app.post('/api/validate-code', async (req, res) => {
    try {
        const { code } = req.body;
        
        if (!code || typeof code !== 'string') {
            return res.status(400).json({
                success: false,
                error: '请提供有效的邀请码'
            });
        }
        
        // 检查表是否有purpose列
        const tableCheck = await pool.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'invitation_codes' AND column_name = 'purpose'
        `);
        
        let query;
        if (tableCheck.rows.length > 0) {
          query = `
            SELECT code, created_by, created_for, max_uses, used_count, 
                   is_active, expires_at, notes, purpose, created_at
            FROM invitation_codes 
            WHERE code = $1
          `;
        } else {
          query = `
            SELECT code, created_by, created_for, max_uses, used_count, 
                   is_active, expires_at, notes, 
                   '系统生成' as purpose, created_at
            FROM invitation_codes 
            WHERE code = $1
          `;
        }
        
        const result = await pool.query(query, [code.toUpperCase()]);
        
        if (result.rows.length === 0) {
            return res.json({
                success: true,
                valid: false,
                error: '邀请码不存在'
            });
        }
        
        const invitationCode = result.rows[0];
        
        let isValid = true;
        let errorMessage = '';
        
        if (!invitationCode.is_active) {
            isValid = false;
            errorMessage = '邀请码已失效';
        } else if (invitationCode.expires_at && new Date() > new Date(invitationCode.expires_at)) {
            isValid = false;
            errorMessage = '邀请码已过期';
        } else if (invitationCode.used_count >= invitationCode.max_uses) {
            isValid = false;
            errorMessage = `邀请码使用次数已达上限 (${invitationCode.used_count}/${invitationCode.max_uses})`;
        }
        
        res.json({
            success: true,
            valid: isValid,
            error: isValid ? null : errorMessage,
            data: isValid ? {
                code: invitationCode.code,
                created_by: invitationCode.created_by,
                created_for: invitationCode.created_for,
                max_uses: invitationCode.max_uses,
                used_count: invitationCode.used_count,
                is_active: invitationCode.is_active,
                expires_at: invitationCode.expires_at,
                notes: invitationCode.notes,
                purpose: invitationCode.purpose,
                created_at: invitationCode.created_at
            } : null
        });
        
    } catch (error) {
        console.error('验证邀请码错误:', error);
        res.status(500).json({
            success: false,
            error: '服务器内部错误',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 9. 获取用户历史记录
app.get('/api/history', authenticateToken, async (req, res) => {
    try {
        console.log('[历史记录API] 开始处理请求');
        console.log('[历史记录API] 用户ID:', req.userId);
        
        if (!req.userId) {
            console.log('[历史记录API] 错误: 用户ID为空');
            return res.status(400).json({
                success: false,
                error: '用户ID无效'
            });
        }
        
        const userId = req.userId;
        
        console.log(`[历史记录API] 查询用户 ${userId} 的记录...`);
        
        try {
            const dbTest = await pool.query('SELECT NOW() as time');
            console.log('[历史记录API] 数据库连接正常:', dbTest.rows[0].time);
        } catch (dbError) {
            console.error('[历史记录API] 数据库连接错误:', dbError);
            return res.status(500).json({
                success: false,
                error: '数据库连接失败'
            });
        }
        
        const userCheck = await pool.query(
            'SELECT id, username FROM users WHERE id = $1',
            [userId]
        );
        
        if (userCheck.rows.length === 0) {
            console.log(`[历史记录API] 用户ID ${userId} 不存在`);
            return res.status(404).json({ 
                success: false, 
                error: '用户不存在' 
            });
        }
        
        console.log(`[历史记录API] 用户 ${userCheck.rows[0].username} (ID: ${userId}) 存在`);
        
        const result = await pool.query(
            `SELECT 
                id,
                match_name,
                handicap_type,
                initial_handicap,
                current_handicap,
                initial_water,
                current_water,
                handicap_change,
                water_change,
                historical_record,
                recommendation,
                actual_result,
                created_at
             FROM records 
             WHERE user_id = $1 
             ORDER BY created_at DESC
             LIMIT 100`,
            [userId]
        );
        
        console.log(`[历史记录API] 查询到 ${result.rows.length} 条记录`);
        
        const formattedRecords = result.rows.map(record => ({
            id: record.id,
            match_name: record.match_name || '未命名赛事',
            handicap_type: record.handicap_type,
            initial_handicap: parseFloat(record.initial_handicap) || 0,
            current_handicap: parseFloat(record.current_handicap) || 0,
            initial_water: parseFloat(record.initial_water) || 0,
            current_water: parseFloat(record.current_water) || 0,
            handicap_change: parseFloat(record.handicap_change) || 0,
            water_change: parseFloat(record.water_change) || 0,
            historical_record: record.historical_record || 'loss',
            recommendation: record.recommendation || '无推荐',
            actual_result: record.actual_result || '',
            created_at: record.created_at
        }));
        
        console.log('[历史记录API] 返回数据成功');
        
        res.json({
            success: true,
            records: formattedRecords,
            count: formattedRecords.length,
            userId: userId,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[历史记录API] 错误:', error);
        res.status(500).json({ 
            success: false, 
            error: '服务器内部错误',
            details: error.message
        });
    }
});

// 10. 保存记录
app.post('/api/records', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const record = req.body;
    
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
    
    if (user.user_type === 'trial' && user.trial_count >= user.max_trial_count) {
      return res.status(403).json({ 
        success: false, 
        error: '试用次数已用完，请注册成为正式会员' 
      });
    }
    
    const result = await pool.query(
      `INSERT INTO records 
       (user_id, match_name, handicap_type, initial_handicap, current_handicap, 
        initial_water, current_water, handicap_change, water_change, 
        historical_record, recommendation, actual_result) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
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
        record.actual_result || ''
      ]
    );
    
    if (user.user_type === 'trial') {
      await pool.query(
        'UPDATE users SET trial_count = trial_count + 1 WHERE id = $1',
        [userId]
      );
    }
    
    res.status(201).json({
      success: true,
      recordId: result.rows[0].id,
      created_at: result.rows[0].created_at,
      remainingTrial: user.user_type === 'trial' ? 
        Math.max(0, user.max_trial_count - user.trial_count - 1) : null,
      message: '记录保存成功'
    });
    
  } catch (error) {
    console.error('保存记录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 11. 更新记录
app.put('/api/records/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req;
    const { actual_result } = req.body;
    
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
    
    await pool.query(
      'UPDATE records SET actual_result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [actual_result, id]
    );
    
    res.json({
      success: true,
      message: '记录更新成功'
    });
    
  } catch (error) {
    console.error('更新记录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 12. 删除记录
app.delete('/api/records/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req;
    
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
    
    await pool.query('DELETE FROM records WHERE id = $1', [id]);
    
    res.json({
      success: true,
      message: '记录删除成功'
    });
    
  } catch (error) {
    console.error('删除记录错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 13. 让球盘推荐
app.post('/api/recommend/asian', async (req, res) => {
  try {
    const data = req.body;
    
    const { 
      initialHandicap, 
      currentHandicap, 
      initialWater, 
      currentWater, 
      historicalRecord 
    } = data;
    
    let recommendation = '上盘';
    let details = '';
    
    const handicapChange = currentHandicap - initialHandicap;
    const waterChange = currentWater - initialWater;
    
    if (handicapChange > 0 && waterChange > 0) {
      recommendation = '上盘';
      details = '盘口和水位同时上升，看好上盘';
    } else if (handicapChange < 0 && waterChange < 0) {
      recommendation = '下盘';
      details = '盘口和水位同时下降，看好下盘';
    } else if (currentWater < 0.85) {
      recommendation = '上盘';
      details = '低水位支撑上盘';
    } else if (historicalRecord === 'win') {
      recommendation = '上盘';
      details = '历史战绩支持上盘';
    } else {
      recommendation = '下盘';
      details = '综合考虑推荐下盘';
    }
    
    res.json({
      success: true,
      recommendation,
      details,
      analysis: {
        handicapChange,
        waterChange,
        confidence: 75,
        factors: ['盘口变化', '水位变化', '历史战绩']
      }
    });
    
  } catch (error) {
    console.error('推荐计算错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '推荐计算失败' 
    });
  }
});

// 14. 大小盘推荐
app.post('/api/recommend/size', async (req, res) => {
  try {
    const data = req.body;
    
    const { 
      initialHandicap, 
      currentHandicap, 
      initialWater, 
      currentWater, 
      historicalRecord 
    } = data;
    
    let recommendation = '大球';
    let details = '';
    
    const handicapChange = currentHandicap - initialHandicap;
    const waterChange = currentWater - initialWater;
    
    if (handicapChange > 0 && waterChange > 0) {
      recommendation = '大球';
      details = '盘口和水位同时上升，看好大球';
    } else if (handicapChange < 0 && waterChange < 0) {
      recommendation = '小球';
      details = '盘口和水位同时下降，看好小球';
    } else if (currentHandicap > 2.5) {
      recommendation = '大球';
      details = '高盘口支撑大球';
    } else if (historicalRecord === 'win') {
      recommendation = '大球';
      details = '历史战绩支持大球';
    } else {
      recommendation = '小球';
      details = '综合考虑推荐小球';
    }
    
    res.json({
      success: true,
      recommendation,
      details,
      analysis: {
        handicapChange,
        waterChange,
        confidence: 70,
        factors: ['盘口变化', '水位变化', '历史战绩']
      }
    });
    
  } catch (error) {
    console.error('推荐计算错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '推荐计算失败' 
    });
  }
});

// 15. 获取统计信息
app.get('/api/stats', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    
    const totalResult = await pool.query(
      'SELECT COUNT(*) as count FROM records WHERE user_id = $1',
      [userId]
    );
    
    const winRateResult = await pool.query(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN actual_result = 'win' THEN 1 ELSE 0 END) as wins
       FROM records 
       WHERE user_id = $1 AND actual_result IS NOT NULL`,
      [userId]
    );
    
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
    console.error('获取统计信息错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 16. 用户信息
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
    console.error('获取用户信息错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// 17. 同步本地数据
app.post('/api/sync', authenticateToken, async (req, res) => {
  try {
    const { userId } = req;
    const { records = [] } = req.body;
    
    const synced = [];
    const errors = [];
    
    for (const record of records) {
      try {
        const existing = await pool.query(
          'SELECT id FROM records WHERE user_id = $1 AND device_id = $2',
          [userId, record.deviceId]
        );
        
        if (existing.rows.length === 0) {
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
          await pool.query(
            `UPDATE records SET 
              match_name = $1, handicap_type = $2, initial_handicap = $3, current_handicap = $4,
              initial_water = $5, current_water = $6, handicap_change = $7, water_change = $8,
              historical_record = $9, recommendation = $10, actual_result = $11, is_synced = true
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
      }
    }
    
    res.json({
      success: true,
      synced,
      errors,
      message: `成功同步 ${synced.length} 条记录`
    });
    
  } catch (error) {
    console.error('同步数据错误:', error);
    res.status(500).json({ 
      success: false, 
      error: '服务器内部错误' 
    });
  }
});

// ============ 管理员API ============

// 18. 管理员生成邀请码
app.post('/api/admin/generate-codes', authenticateAdmin, async (req, res) => {
    try {
        console.log('收到批量生成邀请码请求:', req.body);
        
        const { count, createdBy, purpose, format = 'json' } = req.body;
        
        if (!count || count < 1 || count > 100) {
            return res.status(400).json({
                success: false,
                error: '数量必须在1-100之间'
            });
        }
        
        if (!createdBy) {
            return res.status(400).json({
                success: false,
                error: '请提供创建者名称'
            });
        }
        
        const codes = [];
        const errors = [];
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            for (let i = 0; i < count; i++) {
                try {
                    let code;
                    let isUnique = false;
                    let attempts = 0;
                    
                    while (!isUnique && attempts < 10) {
                        code = generateInvitationCode();
                        const existing = await client.query(
                            'SELECT id FROM invitation_codes WHERE code = $1',
                            [code]
                        );
                        if (existing.rows.length === 0) {
                            isUnique = true;
                        }
                        attempts++;
                    }
                    
                    if (!isUnique) {
                        errors.push(`生成第 ${i + 1} 个邀请码失败，无法生成唯一码`);
                        continue;
                    }
                    
                    const expiresAt = new Date();
                    expiresAt.setDate(expiresAt.getDate() + 30);
                    
                    await client.query(
                        `INSERT INTO invitation_codes 
                         (code, created_by, purpose, is_active, expires_at, notes) 
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [
                            code,
                            createdBy,
                            purpose || '批量生成',
                            true,
                            expiresAt.toISOString(),
                            `批量生成 - ${new Date().toLocaleString('zh-CN')}`
                        ]
                    );
                    
                    codes.push({
                        code: code,
                        created_by: createdBy,
                        purpose: purpose || '批量生成',
                        expires_at: expiresAt.toISOString(),
                        status: 'active'
                    });
                    
                    console.log(`✅ 生成邀请码: ${code}`);
                    
                } catch (error) {
                    errors.push(`生成第 ${i + 1} 个邀请码失败: ${error.message}`);
                }
            }
            
            await client.query('COMMIT');
            
            console.log(`✅ 批量生成了 ${codes.length} 个邀请码`);
            
            if (format === 'text') {
                const codesText = codes.map(c => c.code).join('\n');
                res.setHeader('Content-Type', 'text/plain');
                res.send(`成功生成 ${codes.length} 个邀请码:\n\n${codesText}`);
            } else {
                res.json({
                    success: true,
                    codes: codes,
                    count: codes.length,
                    errors: errors,
                    message: `成功生成 ${codes.length} 个邀请码`
                });
            }
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        
    } catch (error) {
        console.error('批量生成邀请码错误:', error);
        res.status(500).json({
            success: false,
            error: '生成邀请码失败',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 19. 获取申请列表
app.get('/api/invitation-applications', authenticateAdmin, async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;
        
        let query = `
            SELECT application_id, username, email, purpose, notes, 
                   status, review_notes, generated_code, reviewed_by, 
                   reviewed_at, created_at, updated_at
            FROM invitation_applications
        `;
        
        let countQuery = `SELECT COUNT(*) as total FROM invitation_applications`;
        const params = [];
        const countParams = [];
        
        if (status) {
            query += ` WHERE status = $1`;
            countQuery += ` WHERE status = $1`;
            params.push(status);
            countParams.push(status);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(parseInt(limit), offset);
        
        const result = await pool.query(query, params);
        const countResult = await pool.query(countQuery, countParams);
        
        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limit);
        
        res.json({
            success: true,
            applications: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: totalPages,
                hasNext: page < totalPages,
                hasPrev: page > 1
            }
        });
        
    } catch (error) {
        console.error('获取申请列表错误:', error);
        res.status(500).json({
            success: false,
            error: '获取申请列表失败'
        });
    }
});

// 20. 邀请码统计
app.get('/api/invitation-stats', authenticateAdmin, async (req, res) => {
    try {
        const codesStats = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN is_active = true THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN is_active = false THEN 1 ELSE 0 END) as inactive,
                SUM(CASE WHEN expires_at < NOW() THEN 1 ELSE 0 END) as expired,
                SUM(used_count) as total_used,
                SUM(CASE WHEN used_count >= max_uses THEN 1 ELSE 0 END) as fully_used,
                SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) as recent
            FROM invitation_codes
        `);
        
        const appStats = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count
            FROM invitation_applications 
            GROUP BY status
        `);
        
        const usageStats = await pool.query(`
            SELECT 
                DATE_TRUNC('day', created_at) as date,
                COUNT(*) as count
            FROM invitation_codes
            WHERE created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE_TRUNC('day', created_at)
            ORDER BY date DESC
        `);
        
        const stats = {
            codes: codesStats.rows[0],
            applications: appStats.rows.reduce((acc, row) => {
                acc[row.status] = parseInt(row.count);
                return acc;
            }, {}),
            usage: usageStats.rows,
            totals: {
                total_codes: parseInt(codesStats.rows[0].total) || 0,
                total_applications: appStats.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
                available_codes: parseInt(codesStats.rows[0].active) - parseInt(codesStats.rows[0].expired) || 0
            }
        };
        
        res.json({
            success: true,
            stats: stats,
            message: '统计信息获取成功'
        });
        
    } catch (error) {
        console.error('获取统计信息错误:', error);
        res.status(500).json({
            success: false,
            error: '获取统计信息失败'
        });
    }
});

// 21. 获取待审核申请列表
app.get('/api/admin/applications/pending', authenticateAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT application_id, username, email, purpose, notes, created_at
             FROM invitation_applications 
             WHERE status = 'pending'
             ORDER BY created_at DESC`
        );
        
        res.json({
            success: true,
            applications: result.rows,
            count: result.rows.length
        });
        
    } catch (error) {
        console.error('获取待审核申请错误:', error);
        res.status(500).json({
            success: false,
            error: '服务器内部错误'
        });
    }
});

// 22. 审核申请
app.post('/api/admin/applications/:applicationId/review', authenticateAdmin, async (req, res) => {
    try {
        const { applicationId } = req.params;
        const { action, reviewNotes } = req.body;
        const adminId = req.userId;
        
        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'action必须是approve或reject'
            });
        }
        
        const appResult = await pool.query(
            `SELECT * FROM invitation_applications WHERE application_id = $1`,
            [applicationId]
        );
        
        if (appResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: '申请不存在'
            });
        }
        
        const application = appResult.rows[0];
        
        if (application.status !== 'pending') {
            return res.status(400).json({
                success: false,
                error: '该申请已被处理'
            });
        }
        
        const newStatus = action === 'approve' ? 'completed' : 'rejected';
        let generatedCode = null;
        
        await pool.query('BEGIN');
        
        try {
            if (action === 'approve') {
                generatedCode = generateInvitationCode();
                
                await pool.query(
                    `INSERT INTO invitation_codes 
                     (code, created_by, created_for, purpose, is_active, expires_at, notes) 
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        generatedCode,
                        `admin_${adminId}`,
                        application.username,
                        `申请审核通过 - ${application.purpose}`,
                        true,
                        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                        `为申请 ${applicationId} 生成 - ${reviewNotes || '无备注'}`
                    ]
                );
                
                await pool.query(
                    `UPDATE invitation_applications 
                     SET status = 'completed', 
                         review_notes = $1, 
                         reviewed_by = $2, 
                         reviewed_at = $3,
                         generated_code = $4,
                         updated_at = $3
                     WHERE application_id = $5`,
                    [
                        reviewNotes || '',
                        adminId,
                        new Date().toISOString(),
                        generatedCode,
                        applicationId
                    ]
                );
                
            } else {
                await pool.query(
                    `UPDATE invitation_applications 
                     SET status = 'rejected', 
                         review_notes = $1, 
                         reviewed_by = $2, 
                         reviewed_at = $3,
                         updated_at = $3
                     WHERE application_id = $4`,
                    [
                        reviewNotes || '',
                        adminId,
                        new Date().toISOString(),
                        applicationId
                    ]
                );
            }
            
            await pool.query('COMMIT');
            
            console.log(`✅ 申请 ${applicationId} 已${action === 'approve' ? '批准' : '拒绝'}`);
            
            res.json({
                success: true,
                message: `申请已${action === 'approve' ? '批准并生成邀请码' : '拒绝'}`,
                application: {
                    id: applicationId,
                    username: application.username,
                    status: newStatus,
                    generated_code: generatedCode,
                    review_notes: reviewNotes || '',
                    reviewed_at: new Date().toISOString()
                }
            });
            
        } catch (transactionError) {
            await pool.query('ROLLBACK');
            throw transactionError;
        }
        
    } catch (error) {
        console.error('审核申请错误:', error);
        res.status(500).json({
            success: false,
            error: '服务器内部错误',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// 23. 批量操作申请
app.post('/api/admin/applications/batch-action', authenticateAdmin, async (req, res) => {
    try {
        const { applicationIds, action, reviewNotes } = req.body;
        
        if (!Array.isArray(applicationIds) || applicationIds.length === 0) {
            return res.status(400).json({
                success: false,
                error: '请提供申请ID列表'
            });
        }
        
        const results = {
            approved: [],
            rejected: [],
            errors: []
        };
        
        for (const applicationId of applicationIds) {
            try {
                const response = await pool.query(
                    `UPDATE invitation_applications 
                     SET status = $1, 
                         review_notes = $2, 
                         reviewed_by = $3, 
                         reviewed_at = $4,
                         updated_at = $4
                     WHERE application_id = $5 AND status = 'pending'
                     RETURNING application_id, username, purpose`,
                    [
                        action === 'approve' ? 'completed' : 'rejected',
                        reviewNotes || '',
                        req.userId,
                        new Date().toISOString(),
                        applicationId
                    ]
                );
                
                if (response.rows.length > 0 && action === 'approve') {
                    const generatedCode = generateInvitationCode();
                    
                    await pool.query(
                        `INSERT INTO invitation_codes 
                         (code, created_by, created_for, purpose, is_active, expires_at, notes) 
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                            generatedCode,
                            `admin_${req.userId}`,
                            response.rows[0].username,
                            `批量批准 - ${response.rows[0].purpose}`,
                            true,
                            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                            `批量批准 - 申请 ${applicationId}`
                        ]
                    );
                    
                    results.approved.push({
                        applicationId,
                        username: response.rows[0].username,
                        code: generatedCode
                    });
                } else if (response.rows.length > 0) {
                    results.rejected.push(response.rows[0]);
                }
            } catch (error) {
                results.errors.push({ applicationId, error: error.message });
            }
        }
        
        res.json({
            success: true,
            results,
            message: `批量处理完成: ${results.approved.length} 个批准, ${results.rejected.length} 个拒绝, ${results.errors.length} 个错误`
        });
        
    } catch (error) {
        console.error('批量操作错误:', error);
        res.status(500).json({
            success: false,
            error: '服务器内部错误'
        });
    }
});

// 24. 获取申请统计
app.get('/api/admin/applications/stats', authenticateAdmin, async (req, res) => {
    try {
        const statsResult = await pool.query(`
            SELECT 
                status,
                COUNT(*) as count
            FROM invitation_applications 
            GROUP BY status
        `);
        
        const dailyResult = await pool.query(`
            SELECT 
                DATE(created_at) as date,
                COUNT(*) as total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
            FROM invitation_applications 
            WHERE created_at > NOW() - INTERVAL '30 days'
            GROUP BY DATE(created_at)
            ORDER BY date DESC
        `);
        
        res.json({
            success: true,
            stats: {
                by_status: statsResult.rows.reduce((acc, row) => {
                    acc[row.status] = parseInt(row.count);
                    return acc;
                }, {}),
                daily: dailyResult.rows,
                total: statsResult.rows.reduce((sum, row) => sum + parseInt(row.count), 0)
            }
        });
        
    } catch (error) {
        console.error('获取统计错误:', error);
        res.status(500).json({
            success: false,
            error: '服务器内部错误'
        });
    }
});

// 25. 修复表结构
app.post('/api/admin/repair-tables', authenticateAdmin, async (req, res) => {
  try {
    console.log('管理员请求修复表结构...');
    
    const repairedCount = await repairTableColumns();
    
    res.json({
      success: true,
      message: `表结构修复完成，修复了 ${repairedCount} 个缺失列`,
      repairedCount: repairedCount,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('修复表结构失败:', error);
    res.status(500).json({
      success: false,
      error: '修复表结构失败',
      details: error.message
    });
  }
});

// 26. 认证状态检查
app.get('/api/auth/status', (req, res) => {
  const authHeader = req.headers['authorization'];
  console.log('接收到的认证头:', authHeader);
  
  res.json({
    hasAuthHeader: !!authHeader,
    authHeader: authHeader,
    timestamp: new Date().toISOString()
  });
});

// ============ 表结构检查API ============
app.get('/api/check-tables', async (req, res) => {
  try {
    const tables = ['users', 'invitation_codes', 'records', 'statistics', 'invitation_applications'];
    const results = {};
    
    for (const table of tables) {
      try {
        const columns = await pool.query(`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = $1
          ORDER BY ordinal_position
        `, [table]);
        
        results[table] = {
          exists: columns.rows.length > 0,
          columns: columns.rows
        };
      } catch (error) {
        results[table] = {
          exists: false,
          error: error.message
        };
      }
    }
    
    res.json({
      success: true,
      tables: results,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('检查表结构错误:', error);
    res.status(500).json({
      success: false,
      error: '检查表结构失败'
    });
  }
});

// ============ 错误处理 ============
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: '未找到请求的资源'
  });
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({
    success: false,
    error: '服务器内部错误',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============ 启动服务器 ============
const startServer = async () => {
  try {
    await initDatabase();
    
    app.listen(port, () => {
      console.log(`🚀 服务器运行在 http://localhost:${port}`);
      console.log(`📊 健康检查: http://localhost:${port}/`);
      console.log(`🔧 测试端点: http://localhost:${port}/api/test`);
      console.log(`🛠️ 表结构检查: http://localhost:${port}/api/check-tables`);
    });
  } catch (error) {
    console.error('❌ 服务器启动失败:', error);
    process.exit(1);
  }
};

startServer();
