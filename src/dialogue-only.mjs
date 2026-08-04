/**
 * Remove stage directions while preserving the character's spoken text.
 * This is deliberately a formatter, not a general content filter.
 */

const ACTION_CUE =
  /(?:Kuro|小黑|她|貓耳|猫耳|尾巴|視線|视线|眼神|表情|臉|脸|頭|头|手|手指|指尖|身體|身体|衣角|裙|口袋|動作|动作|聲音|声音|語尾|语尾|停頓|停顿|沉默|低聲|低声|小聲|小声|抬|低|垂|看|望|走|站|坐|蹲|拿|摸|遞|递|伸|縮|缩|顫|颤|抖|笑|哭|點頭|点头|搖頭|摇头|靠|抱|握|牽|牵)/u;

export function formatDialogueOnly(text) {
  let result = String(text ?? '').replace(/\r\n?/g, '\n');

  result = result
    .split('\n')
    .map((line) => {
      return line.replace(
        /[（(]([^（）()\n]{1,240})[）)]/gu,
        (match, inner) =>
        ACTION_CUE.test(inner) ? '' : match,
      ).replace(
        /([*＊])([^*＊\n]{1,240})\1/gu,
        (match, _marker, inner) =>
        ACTION_CUE.test(inner) ? '' : match,
      );
    })
    .join('\n');

  return result.replace(/\n{3,}/g, '\n\n').trim();
}
