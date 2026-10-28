/**
 * The dashboard accepts exactly what the machine API accepts: both use the DTOs in gold/dto, whose
 * mode/instrument lists come from gold/domain.
 */
export {
    ActivityQuery,
    ArchiveFileParams,
    ArchiveFileQuery,
    ArchiveListQuery,
    AutomateDto,
    DecisionDto,
    HistoryQuery,
    InstrumentDto,
    NewsQuery,
    RejectDto,
    RunDto,
    settingsBody,
    VALID_INSTRUMENTS,
    VALID_MODES,
} from '../../gold/dto/gold.dto';
