/**
 * Remove stage directions while preserving the character's spoken text.
 * This is deliberately a formatter, not a general content filter.
 */

const NARRATION_SUBJECT =
  /(?:Kuro|小黑|她|貓耳|尾巴|視線|眼神|表情|臉頰|手指|指尖|身體|衣角|裙襬|口袋|動作|語尾)/u;
const ACTION_CUE =
  /(?:Kuro|小黑|她|貓耳|尾巴|視線|眼神|表情|臉|頭|手|手指|指尖|身體|衣角|裙|口袋|動作|聲音|語尾|停頓|沉默|低聲|小聲|抬|低|垂|看|望|走|站|坐|蹲|拿|摸|遞|伸|縮|顫|抖|笑|哭|點頭|搖頭|靠|抱|握|牽)/u;
const ACTION_VERB =
  /(?:抬|低下|垂下|看向|望向|移開|走|站|坐|蹲|拿|摸|遞|伸|縮|顫|抖|笑|哭|點頭|搖頭|靠|抱|握|牽|動了|晃了|豎起|垂落|臉紅)/u;

function isFullStageDirection(line) {
  return /^[（(][\s\S]*[）)](?:[。.!！?？])?$/u.test(line.trim());
}

export function formatDialogueOnly(text) {
  let result = String(text ?? '').replace(/\r\n?/g, '\n');

  result = result
    .split('\n')
    .filter((line) => !isFullStageDirection(line))
    .map((line) => {
      let formatted = line.replace(
        /[（(]([^（）()\n]{1,240})[）)]/gu,
        (match, inner) =>
        ACTION_CUE.test(inner) ? '' : match,
      );

      // When narration and quoted speech share a line, retain the spoken part.
      const quoted = [...formatted.matchAll(/「[^」]+」/gu)].map(
        (match) => match[0],
      );
      if (quoted.length > 0 && formatted.trim() !== quoted.join('')) {
        formatted = quoted.join('');
      }
      return formatted;
    })
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^(?:\*|_).*(?:\*|_)$/u.test(trimmed)) return false;
      if (
        !/「[^」]+」/u.test(trimmed) &&
        NARRATION_SUBJECT.test(trimmed) &&
        ACTION_VERB.test(trimmed)
      ) {
        return false;
      }
      return true;
    })
    .join('\n');

  return result.replace(/\n{3,}/g, '\n\n').trim();
}
