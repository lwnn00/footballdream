// middleware/auth.js
const jwt = require('jsonwebtoken');
require('dotenv').config();

const authMiddleware = {
  // 验证token的中间件
  verifyToken: (req, res, next) => {
    try {
      console.log('=== 开始验证 Token ===');
      console.log('请求路径:', req.path);
      console.log('请求方法:', req.method);
      
      // 1. 获取token（支持多种方式）
      let token;
      
      // 方式1：从 Authorization 头
      if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
        console.log('从Authorization头获取token');
      }
      // 方式2：从查询参数
      else if (req.query.token) {
        token = req.query.token;
        console.log('从查询参数获取token');
      }
      // 方式3：从cookies
      else if (req.cookies && req.cookies.token) {
        token = req.cookies.token;
        console.log('从cookies获取token');
      }
      
      console.log('Token是否存在:', !!token);
      
      // 如果没有token
      if (!token) {
        // 开发环境：可以临时允许访问（添加警告）
        if (process.env.NODE_ENV === 'development') {
          console.warn('⚠️ 开发模式：缺少token，允许访问但标记为未认证');
          req.user = { id: 0, isGuest: true };
          return next();
        }
        
        return res.status(401).json({
          success: false,
          error: '认证失败',
          message: '请提供有效的认证令牌',
          code: 'NO_TOKEN'
        });
      }
      
      // 2. 验证token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      console.log('Token验证成功，用户ID:', decoded.id);
      
      // 3. 将用户信息附加到请求对象
      req.user = decoded;
      next();
      
    } catch (error) {
      console.error('Token验证失败:', error.message);
      
      const errorResponse = {
        success: false,
        error: '认证失败',
        message: error.message,
        code: 'INVALID_TOKEN'
      };
      
      if (error.name === 'TokenExpiredError') {
        errorResponse.message = '令牌已过期，请重新登录';
        errorResponse.code = 'TOKEN_EXPIRED';
      } else if (error.name === 'JsonWebTokenError') {
        errorResponse.message = '无效的令牌格式';
        errorResponse.code = 'INVALID_TOKEN_FORMAT';
      }
      
      res.status(401).json(errorResponse);
    }
  },
  
  // 生成token
  generateToken: (userId) => {
    return jwt.sign(
      { id: userId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );
  },
  
  // 可选认证（有token就用，没有也不报错）
  optionalAuth: (req, res, next) => {
    try {
      let token;
      
      if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        token = req.headers.authorization.split(' ')[1];
      }
      
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
      } else {
        req.user = null;
      }
    } catch (error) {
      req.user = null;
    }
    
    next();
  }
};

module.exports = authMiddleware;
