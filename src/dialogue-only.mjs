/**
 * Remove stage directions while preserving the character's spoken text.
 * This is deliberately a formatter, not a general content filter.
 */

const ACTION_CUE =
  /(?:Kuro|小黑|她|貓耳|尾巴|視線|眼神|表情|臉|頭|手|手指|指尖|身體|衣角|裙|口袋|動作|聲音|語尾|停頓|沉默|低聲|小聲|抬|低|垂|看|望|走|站|坐|蹲|拿|摸|遞|伸|縮|顫|抖|笑|哭|點頭|搖頭|靠|抱|握|牽)/u;

export function formatDialogueOnly(text) {
  let result = String(text ?? '').replace(/\r\n?/g, '\n');

  result = result
    .split('\n')
    .map((line) => {
      return line.replace(
        /[（(]([^（）()\n]{1,240})[）)]/gu,
        (match, inner) =>
        ACTION_CUE.test(inner) ? '' : match,
      );
    })
    .join('\n');

  return result.replace(/\n{3,}/g, '\n\n').trim();
}
