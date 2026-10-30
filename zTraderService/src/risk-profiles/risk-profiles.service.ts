import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { AccountService } from '../account/account.service';
import { GoldAutomateService } from '../gold/gold-automate.service';
import { BUILT_IN_PROFILES, parseProfileValues, resolveProfile, type RiskProfileValues } from './risk-profile-values';
import { RiskProfile, RiskProfileDocument } from './schemas/risk-profile.schema';
import type { CreateRiskProfileDto, UpdateRiskProfileDto } from './risk-profiles.dto';

export interface RiskProfileView {
    id: string;
    name: string;
    description: string;
    builtIn: boolean;
    values: RiskProfileValues;
    /** the settings this profile would set for the current balance; null when a % needs a balance we do not have */
    resolved: Record<string, number> | null;
    createdBy: string | null;
    updatedAt: string | null;
}

@Injectable()
export class RiskProfilesService {
    constructor(
        @InjectModel(RiskProfile.name) private readonly model: Model<RiskProfileDocument>,
        private readonly automate: GoldAutomateService,
        private readonly account: AccountService,
    ) {}

    async list(): Promise<{
        balance: number | null;
        active: ReturnType<GoldAutomateService['riskProfileState']>;
        profiles: RiskProfileView[];
    }> {
        const { balance } = await this.account.summary();
        const custom = await this.model.find().sort({ name: 1 }).lean();
        const profiles: RiskProfileView[] = [
            ...BUILT_IN_PROFILES.map((p) => ({
                id: p.id,
                name: p.name,
                description: p.description,
                builtIn: true,
                values: p.values,
                resolved: resolveProfile(p.values, balance),
                createdBy: null,
                updatedAt: null,
            })),
            ...custom.map((d) => ({
                id: String(d._id),
                name: d.name,
                description: d.description ?? '',
                builtIn: false,
                values: d.values,
                resolved: resolveProfile(d.values, balance),
                createdBy: d.createdBy,
                updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
            })),
        ];
        return { balance, active: this.automate.riskProfileState(), profiles };
    }

    async create(dto: CreateRiskProfileDto, username: string): Promise<RiskProfileView> {
        const values = parseProfileValues(dto.values);
        this.assertNotBuiltInName(dto.name);
        try {
            const doc = await this.model.create({
                name: dto.name.trim(),
                description: dto.description?.trim() ?? '',
                values,
                createdBy: username,
                updatedBy: username,
            });
            return this.view(doc.toObject(), (await this.account.summary()).balance);
        } catch (e: any) {
            if (e?.code === 11000) throw new ConflictException('A risk profile with this name already exists');
            throw e;
        }
    }

    async update(id: string, dto: UpdateRiskProfileDto, username: string): Promise<RiskProfileView> {
        if (id.startsWith('builtin:')) throw new BadRequestException('Built-in profiles cannot be changed');
        const doc = await this.find(id);
        if (dto.name !== undefined) {
            this.assertNotBuiltInName(dto.name);
            doc.name = dto.name.trim();
        }
        if (dto.description !== undefined) doc.description = dto.description.trim();
        if (dto.values !== undefined) {
            doc.values = parseProfileValues(dto.values);
            doc.markModified('values');
        }
        doc.updatedBy = username;
        try {
            await doc.save();
        } catch (e: any) {
            if (e?.code === 11000) throw new ConflictException('A risk profile with this name already exists');
            throw e;
        }
        return this.view(doc.toObject(), (await this.account.summary()).balance);
    }

    async remove(id: string): Promise<{ deleted: true }> {
        if (id.startsWith('builtin:')) throw new BadRequestException('Built-in profiles cannot be deleted');
        const doc = await this.find(id);
        await doc.deleteOne();
        return { deleted: true };
    }

    /** resolve against the live balance and apply through setSettings (validated all-or-nothing, persisted) */
    async apply(
        id: string,
    ): Promise<{ profile: { id: string; name: string }; applied: Record<string, number>; settings: unknown }> {
        const { id: pid, name, values } = await this.profileById(id);
        const { balance } = await this.account.summary(0);
        const body = resolveProfile(values, balance);
        if (!body) {
            throw new BadRequestException(
                'This profile uses a % of the account balance, and the balance is not available (cTrader not connected)',
            );
        }
        const settings = this.automate.setSettings(body, { riskProfile: { id: pid, name, applied: body } });
        return { profile: { id: pid, name }, applied: body, settings };
    }

    private async profileById(id: string): Promise<{ id: string; name: string; values: RiskProfileValues }> {
        const builtIn = BUILT_IN_PROFILES.find((p) => p.id === id);
        if (builtIn) return { id: builtIn.id, name: builtIn.name, values: builtIn.values };
        const doc = await this.find(id);
        return { id: String(doc._id), name: doc.name, values: doc.values };
    }

    private async find(id: string): Promise<RiskProfileDocument> {
        if (!isValidObjectId(id)) throw new NotFoundException('Risk profile not found');
        const doc = await this.model.findById(id);
        if (!doc) throw new NotFoundException('Risk profile not found');
        return doc;
    }

    private assertNotBuiltInName(name: string) {
        const n = name.trim().toLowerCase();
        if (BUILT_IN_PROFILES.some((p) => p.name.toLowerCase() === n)) {
            throw new ConflictException('This name belongs to a built-in profile');
        }
    }

    private view(d: any, balance: number | null): RiskProfileView {
        return {
            id: String(d._id),
            name: d.name,
            description: d.description ?? '',
            builtIn: false,
            values: d.values,
            resolved: resolveProfile(d.values, balance),
            createdBy: d.createdBy,
            updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
        };
    }
}
