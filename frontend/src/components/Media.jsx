import { useEffect, useRef, useState } from 'react'
import { imgSrc, gifSrc } from '../lib/exercises.js'
import { useStore } from '../store/useStore.js'
import { t, exName } from '../lib/i18n.js'
import Icon from './Icon.jsx'

export default function Media({ ex, id, compact, minimizable }) {
  const [playing, setPlaying] = useState(true)
  const [zoomed, setZoomed] = useState(false)
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
  const openZoom = e => { e.stopPropagation(); setZoomed(true) }
  const label = exName(ex) || ex.n
  return (
    <>
      <div className={'exmedia' + (compact ? ' compact' : '') + (mini ? ' mini' : '')} id={id} onClick={() => setPlaying(p => !p)}>
        {/* poster is the still frame, so the card is never blank while the first packet decodes */}
        <video
          ref={vid}
          src={gifSrc(ex)}
          poster={imgSrc(ex)}
          autoPlay loop muted playsInline
          preload="auto"
          disablePictureInPicture
          aria-label={label}
        />
        {!compact && !mini && (
          <button className="gifzoom" onClick={openZoom} aria-label={t('Fullscreen')}>
            <Icon name="expand" />
          </button>
        )}
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
      {zoomed && (
        <div className="media-zoom" onClick={() => setZoomed(false)}>
          <button className="media-zoom-x" onClick={() => setZoomed(false)} aria-label={t('Close')}>
            <Icon name="xmark" />
          </button>
          <div className="media-zoom-box" onClick={e => e.stopPropagation()}>
            <video src={gifSrc(ex)} poster={imgSrc(ex)} autoPlay loop muted playsInline disablePictureInPicture />
          </div>
          <div className="media-zoom-cap">{label}</div>
        </div>
      )}
    </>
  )
}

export function Thumb({ ex }) {
  if (!ex.img) return <div className="thumb thumb-x"><Icon name="dumbbell" /></div>
  return <img className="thumb" loading="lazy" decoding="async" src={imgSrc(ex)} alt="" />
}
