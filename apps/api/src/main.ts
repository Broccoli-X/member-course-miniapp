import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { BusinessErrorFilter } from './common/errors/business-error.filter.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new BusinessErrorFilter());
  await app.listen(Number(process.env.PORT ?? 3000));
}
void bootstrap();
