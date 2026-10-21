import 'reflect-metadata';
import { randomUUID,timingSafeEqual } from 'node:crypto';
import { Body,Controller,Get,Post,Param,Headers,Inject,Module,UseGuards,Injectable,UnauthorizedException,BadRequestException,ConflictException,NotFoundException,ServiceUnavailableException,HttpException,Catch,type ExceptionFilter,type ArgumentsHost,type CanActivate,type ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ApiBearerAuth,ApiBody,ApiHeader,ApiOperation,ApiResponse,DocumentBuilder,SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import type { Request,Response,NextFunction } from 'express';
import { z } from 'zod';
import type { Config } from '../../../packages/platform/src/config.js';
import type { Database } from '../../../packages/database/src/db.js';
import { platformStatus } from '../../../packages/contracts/src/index.js';
import { enqueue,IdempotencyConflict } from '../../../packages/jobs/src/index.js';
import { log } from '../../../packages/platform/src/log.js';
const DB=Symbol('DB'),CONFIG=Symbol('CONFIG');
type TracedRequest=Request & {requestId:string};
@Catch()
class Errors implements ExceptionFilter {
 catch(error:unknown,host:ArgumentsHost){const res=host.switchToHttp().getResponse<Response>();const req=host.switchToHttp().getRequest<TracedRequest>();const status=error instanceof HttpException?error.getStatus():500;
 const code=status===401?'UNAUTHENTICATED':status===400?'INVALID_REQUEST':status===404?'NOT_FOUND':status===409?'IDEMPOTENCY_CONFLICT':status===503?'NOT_READY':'INTERNAL_ERROR';
 res.status(status).json({error:{code,message:status===500?'Unexpected server error':code.replaceAll('_',' ').toLowerCase(),requestId:req.requestId}});
 }
}
@Injectable()
class OperatorGuard implements CanActivate {
 constructor(@Inject(CONFIG)private readonly config:Config){}
 canActivate(context:ExecutionContext){const req=context.switchToHttp().getRequest<Request>();const header=req.headers.authorization??'';if(!header.startsWith('Bearer '))throw new UnauthorizedException();const token=header.slice(7);const a=Buffer.from(token),b=Buffer.from(this.config.DIAGNOSTICS_TOKEN);if(a.length!==b.length||!timingSafeEqual(a,b))throw new UnauthorizedException();return true;}
}
@Controller()
class Health {
 constructor(@Inject(DB)private readonly db:Database){}
 @Get('health/live') @ApiOperation({summary:'Process liveness; no database dependency'}) live(){return {status:'ok',service:'api',mode:'sandbox'};}
 @Get('health/ready') @ApiOperation({summary:'Database/schema and recent-worker readiness'}) async ready(){
  try {const r=await this.db.query("SELECT EXISTS(SELECT 1 FROM platform.worker_heartbeats WHERE seen_at>now()-interval '30 seconds') AS worker");if(!r.rows[0]?.worker)throw new Error('stale worker');return {status:'ready',database:'ready',worker:'ready',mode:'sandbox'};}
  catch{throw new ServiceUnavailableException();}
 }
 @Get('v1/platform') @ApiOperation({summary:'Public sandbox capability declaration'}) status(){return platformStatus;}
}
@Controller('v1/diagnostics/jobs') @UseGuards(OperatorGuard) @ApiBearerAuth()
class Diagnostics {
 constructor(@Inject(DB)private readonly db:Database){}
 @Post() @ApiOperation({summary:'Enqueue harmless diagnostic; not a financial endpoint'}) @ApiHeader({name:'Idempotency-Key',required:true})
 @ApiBody({schema:{type:'object',required:['message'],additionalProperties:false,properties:{message:{type:'string',minLength:1,maxLength:120}}}})
 @ApiResponse({status:201,description:'Job ID and current status'})
 async create(@Headers('idempotency-key')key:string,@Body()body:unknown){
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(key??''))throw new BadRequestException();
  try{const j=await enqueue(this.db,key,body);return {id:j.id,status:j.status};}catch(e){if(e instanceof z.ZodError)throw new BadRequestException();if(e instanceof IdempotencyConflict)throw new ConflictException();throw e;}
 }
 @Get(':id') @ApiOperation({summary:'Read a diagnostic result; operator-only'}) async get(@Param('id')id:string){
  if(!z.uuid().safeParse(id).success)throw new BadRequestException();
  const r=await this.db.query('SELECT id,status,attempts,result,last_error_code FROM platform.jobs WHERE id=$1',[id]);if(!r.rows[0])throw new NotFoundException();return r.rows[0];
 }
}
export async function createApp(db:Database,config:Config,quiet=false){
 @Module({controllers:[Health,Diagnostics],providers:[{provide:DB,useValue:db},{provide:CONFIG,useValue:config},OperatorGuard]})class AppModule{}
 const app=await NestFactory.create(AppModule,{logger:quiet?false:['error','warn'],bodyParser:true});
 app.use(helmet());app.enableCors({origin:config.API_ORIGIN,methods:['GET','POST'],allowedHeaders:['Content-Type','Authorization','Idempotency-Key'],credentials:false});
 app.use((req:TracedRequest,res:Response,next:NextFunction)=>{req.requestId=randomUUID();res.setHeader('X-Request-ID',req.requestId);const start=Date.now();res.on('finish',()=>{if(!quiet)log('http.request',{requestId:req.requestId,method:req.method,status:res.statusCode,durationMs:Date.now()-start});});next();});
 app.useGlobalFilters(new Errors());
 const spec=SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('TransferHub foundation').setVersion('0.1.0').setDescription('Sandbox infrastructure only. No customers, money movement or financial authorisation implemented.').addBearerAuth().build());
 SwaggerModule.setup('docs',app,spec);await app.init();return {app,spec};
}
