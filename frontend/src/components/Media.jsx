import { useEffect, useRef, useState } from 'react'
import { imgSrc, gifSrc } from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'

// Big autoplaying animation; tap toggles pause. `compact` shrinks it (superset cards).
// Custom exercises have no media — the animation stays blank by design (issue #11).
// `minimizable` (workout view) adds a persistent minimize/expand control so the animation stops
// eating the screen; the chosen size is saved to settings and carries across exercises and
// future workouts (issue #12).
//
// This is a <video>, not an <img>: the packaged animations are H.264 (see lib/exercises.js for
// why). Pausing is therefore a property on the element rather than a source swap, which also
// means the paused frame is the frame you were looking at instead of the dataset's still.
export default function Media({ ex, id, compact, minimizable }) {
  const [playing, setPlaying] = useState(true)
  const vid = useRef(null)
  const gifSize = useStore(s => s.S.gifSize)
  const update = useStore(s => s.update)

  useEffect(() => {
    const v = vid.current
    if (!v) return
    if (playing) {
      // play() rejects if the element is detached mid-transition; nothing to recover from.
      v.play().catch(() => {})
    } else {
      v.pause()
    }
  }, [playing, ex.gif])

  if (!ex.gif) return null
  const mini = minimizable && gifSize === 'mini'
  const toggleSize = e => { e.stopPropagation(); update(s => { s.gifSize = mini ? 'full' : 'mini' }) }
  return (
    <div className={'exmedia' + (compact ? ' compact' : '') + (mini ? ' mini' : '')} id={id} onClick={() => setPlaying(p => !p)}>
      {/* poster is the still frame, so the card is never blank while the first packet decodes */}
      <video
        ref={vid}
        src={gifSrc(ex)}
        poster={imgSrc(ex)}
        autoPlay loop muted playsInline
        preload="auto"
        disablePictureInPicture
        aria-label={ex.n}
      />
      {minimizable && (
        <button className="giftoggle" onClick={toggleSize}>
          <Icon name={mini ? 'expand' : 'minimize'} />{mini ? t('Expand') : t('Minimize')}
        </button>
      )}
      {!mini && (
        <span className="gifhint">
          <Icon name={playing ? 'pause' : 'play'} />{playing ? t('tap to pause') : t('tap to play')}
        </span>
      )}
    </div>
  )
}

export function Thumb({ ex }) {
  if (!ex.img) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" src={imgSrc(ex)} alt="" />
}
