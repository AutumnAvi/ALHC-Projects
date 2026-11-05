// Big move 1: the dependencies area's input checks, shared by its reads (the shift previews) and its
// writes. Each refuses with ApiError("invalid", <the message people read>).
import { invalid } from "../core/errors";
import { START_AFTER_DUE, id, optionalDate } from "../core/validate";
import { MAX_SHIFT_MOVES, type ShiftMove } from "../../dependencies";

// The `moves` argument of the shift RPCs: 1 to MAX_SHIFT_MOVES tasks, a missing key keeps that date.
export function shiftMovesInput(moves: ShiftMove[]) {
  if (!Array.isArray(moves) || moves.length === 0 || moves.length > MAX_SHIFT_MOVES) {
    throw invalid(`Choose 1 to ${MAX_SHIFT_MOVES} tasks`);
  }
  return moves.map((m) => {
    const move: Record<string, string | null> = { task_id: id(m.taskId, "task") };
    if (m.startOn !== undefined) move.start_on = optionalDate(m.startOn, "start date");
    if (m.dueOn !== undefined) move.due_on = optionalDate(m.dueOn, "due date");
    if (move.start_on && move.due_on && move.start_on > move.due_on) throw invalid(START_AFTER_DUE);
    return move;
  });
}
