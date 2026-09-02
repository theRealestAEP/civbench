// The playable leaders, extracted from the game's own data files
// (CivilizationVII.app/.../modules/**/data/leaders.xml). A static list on purpose: the leader roster
// only changes with a game update, and reading it live from the shell was fragile (GameInfo.Leaders
// is empty before a match, and the config DB read was context-dependent). To refresh after a game
// update, re-run: grep -hoE 'LeaderType="LEADER_[A-Z_]+"' over the leaders.xml files.
//
// setLeaderTypeName validates each against the config DB, so an unowned-DLC pick simply falls back
// to the default — the harness never blocks on it.
export type Leader = { type: string; name: string };

export const LEADERS: readonly Leader[] = [
  { type: "LEADER_ADA_LOVELACE", name: "Ada Lovelace" },
  { type: "LEADER_ALEXANDER", name: "Alexander" },
  { type: "LEADER_AMINA", name: "Amina" },
  { type: "LEADER_ASHOKA", name: "Ashoka" },
  { type: "LEADER_ASHOKA_ALT", name: "Ashoka (Alt)" },
  { type: "LEADER_AUGUSTUS", name: "Augustus" },
  { type: "LEADER_BENJAMIN_FRANKLIN", name: "Benjamin Franklin" },
  { type: "LEADER_BOLIVAR", name: "Bolivar" },
  { type: "LEADER_CATHERINE", name: "Catherine" },
  { type: "LEADER_CHARLEMAGNE", name: "Charlemagne" },
  { type: "LEADER_CONFUCIUS", name: "Confucius" },
  { type: "LEADER_EDWARD_TEACH", name: "Edward Teach" },
  { type: "LEADER_FRIEDRICH", name: "Friedrich" },
  { type: "LEADER_FRIEDRICH_ALT", name: "Friedrich (Alt)" },
  { type: "LEADER_GENGHIS_KHAN", name: "Genghis Khan" },
  { type: "LEADER_GILGAMESH", name: "Gilgamesh" },
  { type: "LEADER_HARRIET_TUBMAN", name: "Harriet Tubman" },
  { type: "LEADER_HATSHEPSUT", name: "Hatshepsut" },
  { type: "LEADER_HIMIKO", name: "Himiko" },
  { type: "LEADER_HIMIKO_ALT", name: "Himiko (Alt)" },
  { type: "LEADER_IBN_BATTUTA", name: "Ibn Battuta" },
  { type: "LEADER_ISABELLA", name: "Isabella" },
  { type: "LEADER_JOSE_RIZAL", name: "Jose Rizal" },
  { type: "LEADER_LAFAYETTE", name: "Lafayette" },
  { type: "LEADER_LAKSHMIBAI", name: "Lakshmibai" },
  { type: "LEADER_MACHIAVELLI", name: "Machiavelli" },
  { type: "LEADER_NAPOLEON", name: "Napoleon" },
  { type: "LEADER_NAPOLEON_ALT", name: "Napoleon (Alt)" },
  { type: "LEADER_PACHACUTI", name: "Pachacuti" },
  { type: "LEADER_SAYYIDA_AL_HURRA", name: "Sayyida Al Hurra" },
  { type: "LEADER_TECUMSEH", name: "Tecumseh" },
  { type: "LEADER_TOYOTOMI_HIDEYOSHI", name: "Toyotomi Hideyoshi" },
  { type: "LEADER_TRUNG_TRAC", name: "Trung Trac" },
  { type: "LEADER_XERXES", name: "Xerxes" },
  { type: "LEADER_XERXES_ALT", name: "Xerxes (Alt)" },
  { type: "LEADER_YI_SUN_SIN", name: "Yi Sun Sin" },
];
