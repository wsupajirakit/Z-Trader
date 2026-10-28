import { Controller, Get, Query } from '@nestjs/common';
import { RequireRole } from '../common/auth/auth.decorators';
import { AuditService } from './audit.service';
import { ListAuditQuery } from './dto/list-audit.query';

@Controller('api/audit')
@RequireRole('admin')
export class AuditController {
    constructor(private readonly audit: AuditService) {}

    @Get()
    list(@Query() q: ListAuditQuery) {
        return this.audit.list(q.limit, q.before);
    }
}
