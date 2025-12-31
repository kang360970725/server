// src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT || 80);
  app.enableCors({
    origin: [
      'http://pc.welax-tech.com',
      'https://pc.welax-tech.com', // 以后有 https 直接可用
      'http://localhost:8000',
      'http://localhost:8001',
    ],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  await app.listen(port, '0.0.0.0');
}
bootstrap();
