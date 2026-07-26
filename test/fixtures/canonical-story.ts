import type {
  ChapterOutlineOutput,
  CharacterOutput,
  ConceptOutput,
  ContinuityOutput,
  DraftingOutput,
  EditorOutput,
  PlotOutput,
  PublisherOutput,
  WorldbuildingOutput,
} from "../../src/shared/agent-schemas.js";
import type { StoryBible } from "../../src/shared/story-bible.js";

const concept = {
  logline: "閉鎖を控えた夜間郵便局で、配達不能の手紙を拾った新人局員が、差出人の最後の願いを雨の町へ届ける。",
  coreTheme: "言葉は遅れても、人を結び直せる。",
  centralConflict: "規則を守りたい澪と、宛先のない手紙を届けたい気持ちが衝突する。",
  emotionalPromise: "小さな勇気が、長く途切れていた家族の対話を再び動かす温かな余韻。",
  uniqueHook: "消印のない古い手紙と、閉鎖直前の夜間郵便局。",
} satisfies ConceptOutput;

const person = (
  name: string,
  role: string,
  desire: string,
  fear: string,
  flaw: string,
  secret: string,
  arc: string,
  speechStyle: string,
) => ({ name, role, desire, fear, flaw, secret, arc, speechStyle });

const character = {
  protagonist: person(
    "水城澪", "夜間窓口の新人局員", "失敗せず最後の勤務週を終えたい", "善意で誰かを傷つけること", "規則に答えを預けがち", "幼い頃、父への手紙を出せなかった", "規則の意味を考え、自分の判断で一歩を選ぶ", "短く丁寧だが、決意すると語尾が強くなる",
  ),
  antagonist: person(
    "片瀬主任", "閉鎖業務を仕切る主任", "事故なく局を閉めたい", "部下の逸脱で利用者の信頼を失うこと", "過去の失敗から例外を恐れる", "若い頃に私信を届けて苦情を受けた", "澪の行動を通して規則と配慮の両立を認める", "結論を先に置く事務的な話し方",
  ),
  supporting: [person(
    "榊冬子", "手紙の受取人", "亡き姉と和解できなかった理由を知りたい", "姉に忘れられていたと確かめること", "傷つく前に人を遠ざける", "毎年、姉の誕生日に無記名の花を送っていた", "届かなかった言葉を受け取り、自分から返事を書く", "間を置いてから率直な一言を返す",
  )],
} satisfies CharacterOutput;

const worldbuilding = {
  setting: "海沿いの坂町に残る小さな雨坂郵便局。再編で翌朝に窓口を閉じる。",
  rules: ["配達不能郵便は記録して保管する", "職員が私的判断で郵便物を持ち出してはならない"],
  socialContext: "商店街の空洞化が進み、住民は局を町の記憶の置き場として見ている。",
  atmosphere: "雨音、蛍光灯、濡れた石段。冷たい夜から淡い朝へ変わる。",
  locations: ["雨坂郵便局", "海鳴りの石段", "榊冬子の古書店"],
  symbols: ["青い傘", "消印のない封筒", "夜明けの集配車"],
} satisfies WorldbuildingOutput;

const plot = {
  beginning: "澪は閉鎖書類の箱から、住所が途中で消えた古い封筒を見つける。",
  middle: "差出人の手掛かりを町の旧名簿と封筒の押し花からたどり、冬子の古書店へ行き着く。",
  climax: "主任に止められた澪は持ち出さず、冬子を局へ招いて正式な本人確認のうえで手渡す方法を提案する。",
  ending: "冬子は姉の謝罪を読み、夜明けの窓口で返事を書いて澪に託す。",
  twists: ["主任もかつて例外的な配達で失敗していた", "冬子も姉へ匿名の花を送り続けていた"],
  foreshadowingPlan: [{
    item: "青い押し花",
    introduction: "封筒の隅から青い押し花が落ちる",
    payoff: "古書店の栞と同じ花だと冬子が気づく",
  }],
} satisfies PlotOutput;

const chapterOutline = {
  parts: [{
    id: "part-1",
    number: 1,
    title: "雨の最終便",
    chapters: [
      {
        id: "chapter-1",
        partNumber: 1,
        number: 1,
        role: "Opening",
        title: "消印のない夜",
        purpose: "澪が手紙を見つけ、宛先を探す決意をする",
        emotionalTurn: "慎重さから小さな覚悟へ",
        keyEvents: ["閉鎖箱から封筒を発見", "押し花と旧町名を手掛かりにする"],
        foreshadowing: ["青い押し花"],
        lengthPlan: { target: 1200, unit: "characters", min: 1020, max: 1380 },
      },
      {
        id: "chapter-2",
        partNumber: 1,
        number: 2,
        role: "Resolution",
        title: "朝に届く返事",
        purpose: "規則を守る受け渡しを実現し、冬子が返事を書く",
        emotionalTurn: "ためらいから受容へ",
        keyEvents: ["冬子を局へ招く", "手紙を読み返事を投函する"],
        foreshadowing: ["押し花の由来が明かされる"],
        lengthPlan: { target: 1200, unit: "characters", min: 1020, max: 1380 },
      },
    ],
  }],
  styleGuide: {
    pov: "三人称・澪に寄せる",
    tense: "過去形",
    proseStyle: "雨音と手触りを軸にした簡潔な情景描写",
    dialogueNotes: "台詞は短く、沈黙に感情を担わせる",
    taboos: ["奇跡で問題を解決しない", "規則違反を美化しない"],
  },
  foreshadowingTracker: [{
    item: "青い押し花",
    introducedIn: 1,
    status: "paid-off",
    suggestedPayoff: "冬子の栞と結びつける",
    payoffChapter: 2,
    emotionalPurpose: "姉妹が互いを忘れていなかった証にする",
  }],
} satisfies ChapterOutlineOutput;

const drafting = [
  {
    chapterNumber: 1,
    draft: "雨坂郵便局の蛍光灯は、閉鎖を翌朝に控えていつもより白く見えた。水城澪は返却棚の箱を一つずつ封じ、ラベルの年月を読み上げていた。窓の外では雨が細い線になり、海鳴りの石段を洗っている。最後の箱の底から、消印のない封筒が滑り出た。宛名は『榊冬子様』まで読めたが、住所は滲んで町名の半分しか残っていない。封を確かめると、隅から青い押し花が落ちた。片瀬主任は保管記録に戻せと言った。明日から担当局が変わる以上、今夜にできることはない、と。澪も規則は知っていた。それでも旧町名の一覧に、滲んだ二文字と似た『雨坂東』を見つけた。窓口の古い住宅地図には同じ姓が一軒だけあり、今は古書店になっている。澪は封筒を持ち出さず、地図と電話帳を机に並べた。店の番号へ電話をかける指先が止まる。幼い日に書いて出せなかった父への手紙を思い出したからだ。届かない言葉は、書かなかったことと同じではない。澪は主任を見上げ、本人確認をして局で渡すなら規則の内側だと提案した。受話器の向こうで、冬子は長い沈黙のあと『その花は、姉のものです』と答えた。主任は時計を見てから、窓口を閉める時刻までなら待つと言った。澪は青い花を封筒へ戻し、雨の入口に乾いた布を一枚用意した。",
    chapterSummary: "閉鎖前夜、澪は消印のない冬子宛ての手紙を発見する。青い押し花と旧地図から受取人を探し、手紙を持ち出さず局で本人確認して渡す案を主任に認めさせる。",
    continuityNotes: ["封筒は局内に保管", "冬子は青い押し花を姉のものと認識", "主任は閉局時刻まで待つことを許可"],
  },
  {
    chapterNumber: 2,
    draft: "閉局時刻の十分前、青い傘がガラス戸の向こうに止まった。榊冬子は濡れた肩を布で押さえ、差し出された確認票にゆっくり名前を書いた。澪は記録欄を埋め、主任の確認印を受けてから封筒を渡した。冬子はすぐには開けず、青い押し花を掌に載せた。古書店で栞にしている花と同じだという。姉妹は長く口をきかなかったが、冬子は毎年、姉の誕生日に差出人を書かず花を送っていた。手紙には、姉もそれが冬子からだと気づいていたこと、返事をためらううち病を得たこと、遅すぎても謝りたいことが綴られていた。冬子は読み終えると泣かずに笑った。『遅いですね。でも、私も同じでした』。片瀬主任はカウンターの奥で閉鎖書類を揃えながら、かつて善意で私信を届け、受取人を困らせた話をした。だから例外を恐れていたのだと。澪は、今夜したのは例外ではなく、規則の目的を守る工夫だったと答えた。夜明けが窓を薄青くすると、冬子は便箋を一枚借りた。亡き姉への返事は配達できない。それでも書き終えた紙を新しい封筒へ入れ、自分の住所を宛先にした。『届いたことを、明日の私に知らせます』。最初の集配車が来るころ、澪はその封筒に朝一番の消印を押した。青い傘が石段を下り、雨はもう海の上だけに残っていた。",
    chapterSummary: "冬子は局で本人確認を済ませ、亡き姉の謝罪の手紙を読む。互いに相手を思っていた事実を知り、自分宛ての返事を書いて朝一番の便へ託す。主任も澪の判断を認める。",
    continuityNotes: ["青い押し花を回収", "姉は故人", "冬子の返事は冬子自身宛て", "郵便局は夜明けに閉鎖"],
  },
] satisfies DraftingOutput[];

const editor = {
  strengths: ["雨から夜明けへの変化が心情の推移と重なる", "規則を破らず葛藤を解く選択が一貫している"],
  weakPoints: ["主任の過去の説明が一箇所に集中している"],
  pacing: ["第一章の手掛かり探索は簡潔で、第二章の対話に十分な余白がある"],
  dialogue: ["冬子の短い応答が抑制された人物像に合う"],
  emotionalClarity: ["澪の未投函の手紙と現在の決断の対応が明瞭"],
  revisionSuggestions: ["主任の過去を第一章の仕草でわずかに予告する"],
} satisfies EditorOutput;

const continuity = {
  issues: [],
  unresolvedForeshadowing: [],
  missingPayoffs: [],
  overallAssessment: "人物の動機、封筒の所在、青い押し花の導入と回収に矛盾はなく、二章の時間も連続している。",
} satisfies ContinuityOutput;

const publisher = {
  promotedTitle: "雨の最終便",
  titleIdeas: ["雨の最終便", "朝に届く手紙", "青い花の消印"],
  shortSynopsis: "閉鎖前夜の郵便局で、新人局員が宛先の消えた手紙を見つける。",
  longSynopsis: "閉鎖を翌朝に控えた雨坂郵便局で、新人局員の澪は消印のない古い手紙を発見する。規則と善意の間で迷いながら受取人の冬子を探し、正式な手続きで手渡す道を選ぶ。亡き姉の謝罪を読んだ冬子は、自分自身へ返事を送り、届かなかった言葉を明日へつなぐ。",
  logline: concept.logline,
  tagline: "遅れた言葉にも、朝は来る。",
  socialPosts: ["閉鎖前夜の郵便局。消印のない手紙が、止まっていた姉妹の時間を動かす。短編『雨の最終便』。"],
  submissionDescription: "海沿いの小さな郵便局を舞台に、規則と善意、届かなかった家族の言葉を描く二章構成の現代短編。",
} satisfies PublisherOutput;

export const canonicalOutputs = {
  concept,
  character,
  worldbuilding,
  plot,
  "chapter-outline": chapterOutline,
  drafting,
  editor,
  continuity,
  publisher,
};

const chapters = chapterOutline.parts[0]!.chapters.map((chapter) => {
  const output = drafting.find(({ chapterNumber }) => chapterNumber === chapter.number)!;
  return { ...chapter, ...output };
});

export const canonicalBible: StoryBible = {
  concept,
  theme: concept.coreTheme,
  characters: character,
  worldbuilding,
  plot,
  parts: [{ ...chapterOutline.parts[0]!, chapters }],
  chapters,
  styleGuide: chapterOutline.styleGuide,
  foreshadowingTracker: chapterOutline.foreshadowingTracker,
  editorReport: editor,
  continuityReport: continuity,
  publisherPackage: publisher,
};

export const extractionCases = [
  { kind: "code-fence", raw: `\`\`\`json\n${JSON.stringify(concept)}\n\`\`\`` },
  { kind: "preamble", raw: `こちらが結果です。\n${JSON.stringify(concept)}` },
  { kind: "broken-json", raw: '{"logline":"閉じていない"' },
] as const;
