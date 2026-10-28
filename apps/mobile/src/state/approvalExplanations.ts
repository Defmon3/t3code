import { createApprovalExplanationAtoms } from "@t3tools/client-runtime/state/approval-explanations";
import { connectionAtomRuntime } from "../connection/runtime";

export const approvalExplanationAtom = createApprovalExplanationAtoms(connectionAtomRuntime);
