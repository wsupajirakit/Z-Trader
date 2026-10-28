import { AiPanel } from './ai/AiPanel';
import { LoopControls } from './automate/LoopControls';
import { ManualRun } from './automate/ManualRun';
import { InstrumentPicker } from './instruments/InstrumentPicker';

export function BotControlCard() {
  return (
    <div className="card">
      <h2>Bot Control</h2>
      <InstrumentPicker />
      <ManualRun />
      <LoopControls />
      <AiPanel />
    </div>
  );
}
