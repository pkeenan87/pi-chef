import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi, type EditorTheme } from "@earendil-works/pi-tui";
import { MAX_INTERVIEW_QUESTIONS } from "../orchestrator/prompts.js";
import type { InterviewAnswer, InterviewQuestion } from "../orchestrator/interview.js";
import type { Workflow } from "../orchestrator/service.js";

export const OTHER_VALUE = "__other__";
const OTHER_LABEL = "Other (type answer)";

const OptionSchema = Type.Object({
  value: Type.String({ description: "Value returned when selected" }),
  label: Type.String({ description: "Short display label" }),
  description: Type.Optional(Type.String({ description: "One line shown under the label" })),
});

const QuestionSchema = Type.Object({
  id: Type.String({ description: "Unique id for this question" }),
  title: Type.String({ description: "Short tab label, for example 'Storage'" }),
  prompt: Type.String({ description: "The question, worded so that accepting the recommendation is the easy path" }),
  options: Type.Array(OptionSchema, { description: "2 to 4 options" }),
  recommended: Type.String({ description: "The value of the recommended option" }),
  reason: Type.String({ description: "One line on why it is recommended" }),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Ids of earlier-round questions whose answers this one needs" })),
});

export const PlanQuestionsParams = Type.Object({
  round: Type.Integer({ minimum: 1, description: "1 for the first round, then 2, 3, ..." }),
  questions: Type.Array(QuestionSchema, { description: `Every question whose prerequisites are settled. At most ${MAX_INTERVIEW_QUESTIONS} questions across all rounds.` }),
});

/** What the dialog hands back. A cancelled dialog carries no answers. */
export interface QuestionsUiResult {
  answers: InterviewAnswer[];
  cancelled: boolean;
}

export interface DialogOptions {
  allowOther: boolean;
  /** Heading shown above the tab bar. */
  heading?: string;
}

interface Row {
  value: string;
  label: string;
  description?: string;
  isOther?: boolean;
}

export function recommendedAnswer(question: InterviewQuestion): InterviewAnswer {
  const option = question.options.find((item) => item.value === question.recommended) ?? question.options[0]!;
  return { id: question.id, value: option.value, label: option.label, wasCustom: false, acceptedRecommendation: true };
}

/** Rows shown for one question: its options with the recommendation marked, then "Other". */
export function rowsFor(question: InterviewQuestion, allowOther: boolean): Row[] {
  const rows: Row[] = question.options.map((option) => ({
    value: option.value,
    label: option.value === question.recommended ? `${option.label}  ★ Recommended — ${question.reason}` : option.label,
    description: option.description,
  }));
  if (allowOther) rows.push({ value: OTHER_VALUE, label: OTHER_LABEL, isOther: true });
  return rows;
}

interface Theme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

type Tui = { requestRender(): void } & Record<string, unknown>;

/**
 * The dialog component handed to `ctx.ui.custom`. Every question starts on its recommendation (already
 * answered), so Enter through the tabs or the "a" key accepts them. Adapted from Pi's questionnaire example.
 */
export function questionsDialog(questions: InterviewQuestion[], options: DialogOptions, tui: Tui, theme: Theme, done: (result: QuestionsUiResult) => void) {
  const answers = new Map<string, InterviewAnswer>(questions.map((question) => [question.id, recommendedAnswer(question)]));
  const multi = questions.length > 1;
  const totalTabs = questions.length + 1;
  let tab = 0;
  let index = 0;
  let inputMode = false;
  let cached: string[] | undefined;

  const editorTheme = {
    borderColor: (text: string) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    },
  } as unknown as EditorTheme;
  const editor = new Editor(tui as never, editorTheme);

  const refresh = () => {
    cached = undefined;
    tui.requestRender();
  };
  const current = () => questions[tab];
  const rows = () => (current() ? rowsFor(current()!, options.allowOther) : []);
  const submit = (cancelled: boolean) => done({ answers: cancelled ? [] : questions.map((question) => answers.get(question.id) ?? recommendedAnswer(question)), cancelled });

  /** Puts the cursor on the option that is currently chosen for the question on this tab. */
  const settle = () => {
    const question = current();
    if (!question) return;
    const answer = answers.get(question.id);
    const at = answer?.wasCustom ? question.options.length : question.options.findIndex((option) => option.value === (answer?.value ?? question.recommended));
    index = Math.max(0, at);
  };
  const go = (next: number) => {
    tab = (next + totalTabs) % totalTabs;
    settle();
    refresh();
  };
  const advance = () => {
    if (!multi) return submit(false);
    go(Math.min(tab + 1, questions.length));
  };
  const accept = (question: InterviewQuestion, row: Row) => {
    answers.set(question.id, { id: question.id, value: row.value, label: row.label.split("  ★")[0]!, wasCustom: false, acceptedRecommendation: row.value === question.recommended });
  };

  settle();

  editor.onSubmit = (value: string) => {
    const question = current();
    if (!question) return;
    const text = value.trim() || "(no response)";
    answers.set(question.id, { id: question.id, value: text, label: text, wasCustom: true, acceptedRecommendation: false });
    inputMode = false;
    editor.setText("");
    advance();
  };

  function handleInput(data: string): void {
    if (inputMode) {
      if (matchesKey(data, Key.escape)) {
        inputMode = false;
        editor.setText("");
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }
    if (data === "a" || data === "A") {
      // Accept all recommendations for the round.
      for (const question of questions) answers.set(question.id, recommendedAnswer(question));
      submit(false);
      return;
    }
    if (multi) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) return go(tab + 1);
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) return go(tab - 1);
    }
    if (tab === questions.length) {
      if (matchesKey(data, Key.enter)) submit(false);
      else if (matchesKey(data, Key.escape)) submit(true);
      return;
    }
    const list = rows();
    if (matchesKey(data, Key.up)) {
      index = Math.max(0, index - 1);
      return refresh();
    }
    if (matchesKey(data, Key.down)) {
      index = Math.min(list.length - 1, index + 1);
      return refresh();
    }
    if (matchesKey(data, Key.enter)) {
      const question = current();
      const row = list[index];
      if (!question || !row) return;
      if (row.isOther) {
        inputMode = true;
        editor.setText("");
        return refresh();
      }
      accept(question, row);
      return advance();
    }
    if (matchesKey(data, Key.escape)) submit(true);
  }

  function render(width: number): string[] {
    if (cached) return cached;
    const lines: string[] = [];
    const w = Math.max(1, width);
    const wrap = (prefix: string, text: string) => {
      const pad = visibleWidth(prefix);
      if (pad >= w) return void lines.push(...wrapTextWithAnsi(prefix + text, w));
      wrapTextWithAnsi(text, w - pad).forEach((line, i) => lines.push(`${i === 0 ? prefix : " ".repeat(pad)}${line}`));
    };
    const question = current();
    lines.push(theme.fg("accent", "─".repeat(w)));
    if (options.heading) wrap(" ", theme.fg("accent", theme.bold(options.heading)));
    if (multi) {
      const tabs = ["← "];
      questions.forEach((item, i) => {
        const text = ` ${answers.get(item.id)?.acceptedRecommendation === false ? "■" : "□"} ${item.title} `;
        tabs.push(`${i === tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg("muted", text)} `);
      });
      const submitText = " ✓ Submit ";
      tabs.push(`${tab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg("success", submitText)} →`);
      wrap(" ", tabs.join(""));
      lines.push("");
    }
    const list = () => {
      rows().forEach((row, i) => {
        const selected = i === index;
        wrap(selected ? theme.fg("accent", "> ") : "  ", theme.fg(selected ? "accent" : "text", `${i + 1}. ${row.label}${row.isOther && inputMode ? " ✎" : ""}`));
        if (row.description) wrap("     ", theme.fg("muted", row.description));
      });
    };
    if (inputMode && question) {
      wrap(" ", theme.fg("text", question.prompt));
      lines.push("");
      list();
      lines.push("", ...[" Your answer:", ...editor.render(Math.max(1, w - 2)).map((line) => ` ${line}`)], "");
      wrap(" ", theme.fg("dim", "Enter to submit • Esc to go back"));
    } else if (tab === questions.length) {
      wrap(" ", theme.fg("accent", theme.bold("Ready to submit")));
      lines.push("");
      for (const item of questions) {
        const answer = answers.get(item.id)!;
        wrap(" ", `${theme.fg("muted", `${item.title}: `)}${theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.label}${answer.acceptedRecommendation ? " ★" : ""}`)}`);
      }
      lines.push("");
      wrap(" ", theme.fg("success", "Enter to submit • a accepts all recommendations"));
    } else if (question) {
      wrap(" ", theme.fg("text", question.prompt));
      lines.push("");
      list();
    }
    lines.push("");
    if (!inputMode) wrap(" ", theme.fg("dim", `${multi ? "Tab/←→ navigate • " : ""}↑↓ select • Enter confirm • a accept all recommendations • Esc cancel`));
    lines.push(theme.fg("accent", "─".repeat(w)));
    cached = lines;
    return lines;
  }

  return {
    render,
    invalidate: () => {
      cached = undefined;
    },
    handleInput,
  };
}

/** Shows the dialog. Resolves with the person's answers, or `cancelled: true` when they dismissed it. */
export function askQuestions(ctx: Pick<ExtensionContext, "ui">, questions: InterviewQuestion[], options: DialogOptions): Promise<QuestionsUiResult> {
  return ctx.ui.custom<QuestionsUiResult>((tui, theme, _keys, done) => questionsDialog(questions, options, tui as unknown as Tui, theme as unknown as Theme, done));
}

/** Keeps only answers that belong to the round, and fills any the dialog left out with the recommendation. */
export function completeAnswers(questions: InterviewQuestion[], given: InterviewAnswer[]): InterviewAnswer[] {
  return questions.map((question) => {
    const answer = given.find((item) => item.id === question.id);
    if (!answer || typeof answer.value !== "string" || !answer.value) return recommendedAnswer(question);
    const option = question.options.find((item) => item.value === answer.value);
    if (!answer.wasCustom && !option) return recommendedAnswer(question);
    return {
      id: question.id,
      value: answer.value,
      label: answer.wasCustom ? answer.label || answer.value : option?.label ?? answer.label,
      wasCustom: !!answer.wasCustom,
      acceptedRecommendation: !answer.wasCustom && answer.value === question.recommended,
    };
  });
}

export function summarizeAnswers(questions: InterviewQuestion[], answers: InterviewAnswer[]): string[] {
  return answers.map((answer) => {
    const title = questions.find((item) => item.id === answer.id)?.title ?? answer.id;
    return `[${answer.id}] ${title}: ${answer.label}${answer.wasCustom ? " (user wrote this)" : answer.acceptedRecommendation ? " (accepted the recommendation)" : " (chose another option)"}`;
  });
}

export function createPlanQuestionsTool(getWorkflow: () => Workflow | undefined) {
  return defineTool({
    name: "plan_questions",
    label: "Plan Questions",
    description: `Ask the user a round of planning DECISIONS (not facts you can look up). Each question has 2-4 options, one recommendation with a reason, and an "Other" choice; the user can accept all recommendations at once. At most ${MAX_INTERVIEW_QUESTIONS} questions in total across all rounds. Only usable while /plan is running.`,
    promptSnippet: "plan_questions: ask the user a round of planning decisions with recommendations",
    parameters: PlanQuestionsParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const workflow = getWorkflow();
      if (!workflow) throw new Error("The cost workflow is not available.");
      const questions: InterviewQuestion[] = params.questions.map((question) => ({
        id: question.id,
        title: question.title,
        prompt: question.prompt,
        options: question.options.map((option) => ({ value: option.value, label: option.label, ...(option.description ? { description: option.description } : {}) })),
        recommended: question.recommended,
        reason: question.reason,
        ...(question.dependsOn?.length ? { dependsOn: question.dependsOn } : {}),
      }));
      const begun = await workflow.beginQuestionRound({ round: params.round, questions });
      const headless = !ctx.hasUI;
      let answers: InterviewAnswer[];
      if (headless) {
        answers = questions.map(recommendedAnswer);
      } else {
        let result: Awaited<ReturnType<typeof askQuestions>>;
        try {
          result = await askQuestions(ctx, questions, { allowOther: true, heading: `Plan interview · round ${begun.round}` });
        } catch (error) {
          workflow.abandonQuestionRound();
          throw error;
        }
        if (result.cancelled) {
          workflow.abandonQuestionRound();
          return {
            content: [{ type: "text" as const, text: "The user dismissed the questions without answering. Nothing was recorded. Ask in plain text whether to continue the interview or write the spec with your recommendations as assumptions." }],
            details: { round: begun.round, cancelled: true },
          };
        }
        answers = completeAnswers(questions, result.answers);
      }
      const totals = await workflow.recordInterviewAnswers(begun.round, questions, answers, headless);
      const lines = [
        ...(headless ? ["No UI was available, so the recommendations were recorded as the answers. Treat them as assumptions."] : []),
        ...summarizeAnswers(questions, answers),
        "",
        `Questions asked: ${totals.asked}/${MAX_INTERVIEW_QUESTIONS}.`,
        totals.remaining === 0
          ? "The cap is reached. Call plan_spec now."
          : `At most ${totals.remaining} more may be asked. Ask another round only for decisions that are still open and now unblocked; otherwise call plan_spec.`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { round: begun.round, answers, headless, asked: totals.asked, remaining: totals.remaining } };
    },
  });
}
