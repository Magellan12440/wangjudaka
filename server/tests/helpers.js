/** 测试夹具：构造一份合法的分镜编译请求 */
export function makeReq(overrides = {}) {
  const base = {
    kind: 'video',
    shot_no: 'E01-S012',
    available_credits: 10000,
    project: {
      style_code: 'STY-XUANYI',
      director_code: 'DIR-NOIR',
      aspect: '9:16',
      quality: '1080p',
    },
    shot: {
      duration: 5,
      shot_card: 'SHT-MCU',
      camera_move: 'SHT-PUSH',
      emotion: '低沉对峙',
      characters: ['CH01'],
      scene: 'SC01B',
      props: ['PR01'],
      offscreen: [],
      action_start: 'his palms press flat on the glass table, jaw tight',
      action_end: 'his eyes lift slowly and harden',
      action_start_zh: '他双手平按在玻璃桌上，下颌紧绷',
      action_end_zh: '他缓缓抬眼，眼神变硬',
      ambient: ['dust particles in the lamp beam'],
      ambient_sound: 'low room hum, distant rain',
      music_entry: 'No music',
      dialogue: '你以为这就结束了？',
      speaker: 'CH01',
      first_frame_url: 'cos://proj/E01-S012-v2.png',
      // 情绪是资产：在场角色必须绑定情绪卡（低沉对峙 → 压抑的暴怒）
      emotions: { CH01: 'EMO-RAGE-SUPPRESSED-04' },
    },
    emotion_map: {},
    lighting: { codes: ['LIG-PRACTICAL'] },
    transition: { code: 'TRN-OBJWIPE', reason: '用暗物遮挡完成时间跳跃' },
    assets: {
      characters: {
        CH01: {
          asset_code: 'CH01',
          name: '林默',
          image_url: 'cos://asset/CH01/v3.png',
          version: 3,
          locks: [
            'pine-green lapel service jacket',
            'silver ring earring on left ear',
            'lean face with high cheekbone',
            'short black hair, side part',
          ],
          lock_values: {},
        },
      },
      scenes: {
        SC01B: {
          asset_code: 'SC01B',
          name: '审讯室',
          image_url: 'cos://asset/SC01B/v2.png',
          version: 2,
          locks: ['single desk lamp, glass table, two chairs', 'concrete wall with water stain', 'window on the left, cold daylight'],
          lock_values: {},
        },
      },
      props: {
        PR01: {
          asset_code: 'PR01',
          name: '银色打火机',
          image_url: 'cos://asset/PR01/v1.png',
          version: 1,
          locks: ['scratched chrome zippo with engraved character', 'matte silver shell, worn edges', 'faint initials carved on the lid'],
          lock_values: {},
        },
      },
      emotions: {
        CH01: {
          asset_code: 'EM01',
          name: '林默·压抑的暴怒',
          asset_type: 'emotion',
          lock_values: { name: '林默·压抑的暴怒' },
        },
      },
    },
    model: 'VID-DEFAULT',
    options: { purpose: 'delivery', seed: 88123 },
  };
  return deepMerge(base, overrides);
}

export function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object') {
      out[k] = deepMerge(a[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
