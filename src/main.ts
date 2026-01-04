// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

function parseCorsWhitelist(env?: string): string[] {
  if (!env) return [];
  return env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const nodeEnv = process.env.NODE_ENV || 'development';
  const isProd = nodeEnv === 'production';

  // ✅ 端口策略：开发 3000，线上 80（PORT 可覆盖）
  const defaultPort = isProd ? 80 : 3000;
  const port = Number(process.env.PORT || defaultPort);

  // ✅ 线上默认域名白名单（可用 CORS_ORIGINS 追加/覆盖）
  const defaultProdWhitelist = [
    'http://pc.welax-tech.com',
    'https://pc.welax-tech.com',
  ];

  // ✅ 开发默认允许的前端来源（再额外放开 localhost 任意端口）
  const defaultDevWhitelist = [
    'http://localhost:8000',
    'http://localhost:8001',
    'http://127.0.0.1:8000',
    'http://127.0.0.1:8001',
  ];

  const envWhitelist = parseCorsWhitelist(process.env.CORS_ORIGINS);

  // 若设置了 CORS_ORIGINS，则以它为准；否则用默认值
  const whitelist =
      envWhitelist.length > 0
          ? envWhitelist
          : isProd
          ? defaultProdWhitelist
          : defaultDevWhitelist;

  // 开发时允许 localhost/127.0.0.1 任意端口（适配你“本地转发访问/临时端口”）
  const devLocalhostRegex = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

  app.enableCors({
    credentials: true,
    origin: (origin, callback) => {
      // ✅ 非浏览器/服务端转发/健康检查常常没有 Origin：直接放行
      if (!origin) return callback(null, true);

      if (!isProd) {
        if (devLocalhostRegex.test(origin) || whitelist.includes(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      }

      // 生产环境严格白名单
      if (whitelist.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // ✅ 端口占用时给出更清晰的提示
  try {
    await app.listen(port, '0.0.0.0');
    console.log(`[Nest] ${nodeEnv} listening on http://0.0.0.0:${port}`);
  } catch (e: any) {
    if (e?.code === 'EADDRINUSE') {
      console.error(
          `[Nest] Port ${port} is already in use. ` +
          (isProd
              ? `线上用 80 时通常是 Nginx/其他服务占用；请停掉占用者或改用 PORT。`
              : `开发请确保 3000 未被占用，或用 PORT=3001 启动。`),
      );
    }
    throw e;
  }
}

bootstrap();
