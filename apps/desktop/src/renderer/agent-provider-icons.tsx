import React from "react";
import {Icon} from "@hetu/workbench-ui";
import {externalProviders} from "../shared/external-ai.ts";

// 图标几何与离线资源来自Orca；原MIT许可见assets/licenses/orca-MIT.txt。
export function OpenAIIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className}
      fill="currentColor"
      fillRule="evenodd"
      height={size}
      width={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  )
}


export function ClaudeIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={className}
      height={size}
      width={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"
        fill="#D97757"
        fillRule="nonzero"
      />
    </svg>
  )
}


export function PiIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // 复用Orca登记的Pi图标几何。
  return (
    <svg
      aria-hidden
      height={size}
      width={size}
      viewBox="0 0 800 800"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  )
}


export function KiloIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // SVG from Kilo-Org/kilocode:packages/kilo-vscode/assets/icons/kilo-light.svg; retain brand yellow/black for legibility in both themes.
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{ borderRadius: 2 }}
    >
      <path d="M512 0H0V512H512V0Z" fill="black" />
      <path
        d="M322 377H377V421H307.857L278 391.143V322H322V377ZM421 307.857L391.143 278H322V322L377 322V377H421V307.857ZM234 278H190V322H234V278ZM91 391.143L120.857 421H234V377H135V278H91V391.143ZM371.172 189.999V120.856L341.315 90.9995H278V135H327.172V189.999H278V233.999H421V189.999H371.172ZM135 91H91V233.999H135V184.5H190V233.999H234V184.5L190 140.5H135V91ZM234 91H190V140.5H234V91Z"
        fill="#FAF74F"
      />
    </svg>
  )
}


export function OpenCodeIcon({
  size = 14,
  className
}: {
  size?: number
  className?: string
}): React.JSX.Element {
  // 复用Orca登记的OpenCode图标几何，浅暗主题采用当前文字色。
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path d="M320 224V352H192V224H320Z" fill="currentColor" fillOpacity="0.28" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="currentColor"
      />
    </svg>
  )
}


export function AgentLetterIcon({
  letter,
  size = 14,
  className
}: {
  letter: string
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 14 14"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect width="14" height="14" rx="3" fill="currentColor" fillOpacity="0.2" />
      <text
        x="7"
        y="10.5"
        textAnchor="middle"
        fontSize="8.5"
        fill="currentColor"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, sans-serif"
      >
        {letter}
      </text>
    </svg>
  )
}

const favicons:Record<string,string>={"hermes":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAPFBMVEVzc3Pn5+ccHBszMzMBAQH///8AAAAYGBgLCwscHBxLS0vGxsbX19dfX19+fn7z8/OgoKCysrKGhoaSkpIgp1CAAAAACnRSTlP9////ff//gICA//OAVQAABGdJREFUWIWll4uWnCAMQANUuiXh/f//2gRQAZ1te8rZs6MOXPNOBn7Af60f8Cse/7HUF/xUn76MmIJ3zodM/w6IRDml4uxYgO+CfgBQShnba1U6ESa9IV4BebxXB/lK+QuBfwXI2t6rypOy3n4PIGeX5eTbcN36PwGS3ZcWzS8tLHwLiP5xnDVnQtTnrU7fAJTZT2vtq5eX5v5Ae4v4EaBMe89N8c5mMaoccSKMNiGpED8BjNO6ndKDYUhsZsHwf7SWTVlEm/QBUCoTjE38KvBOGOnIKpJxSkKqpphTjCyQia8AQiJvTMrVGeRHThIgskLGuiL+0Zg0uMTo/ArI/KFqbW+jopTsihGaI8SVirXjS8cAH18AlChGRVB9CRokgkz1tQ5rdDNa/muGohcAeO0L6OGD0+1mXJRDEQe0k7BgQHkBaDf5z27xbD00J8hzPWJrA9Dlu+7AjaCT9m6A9VBpBdRL7H4grAC2CHuAwabvCw8AbAeSXm61JAmf1q4D3ANwZdE4CHUFdN3ZGONefQaMK1pFuFXpn/hZhVFHfbeCeRCGii9GPBd5KLaqI0EpIe+EISDsADo3tNJbsTifh7NXXYYO5hFIvlmqUE+U3EpRV3TIMOLktJHaAapJB1jbKRLRi4V4AQIi+UkH3AFcj0wSo41UKxyvQJMEdrjYd5XqA8AZn9Em0+I8YoYS6MUGLRjtHUprVVY2lO4gzmw1jLg7cujwCkBrpkztK34A0Bsg28f528GbI9MbILFt9hacd8AQwb8BqlUYt2Hi6qx6Beg3ANgY9xa+F6crHegF4Cwbf7Ph5sVWFScjrAAu+Rj6ZHLaYrehVIYugnsC+G2eG5yBSQ1c9Ze6IlkhUsQHgPPBqoQHTmr0PL8tKScF4Ec6LAARN6h1lmqVxuAsQasyeVTWBdC2TePG5YSibgmGQqh7TRiAPgS2+WadYboT6JpQWmltgNCN0AHU63yY/HsCesyco9M16VjM3QgdUHoKzO6Z7Gr9FUy3N5D1TQoHwIdrs+wnTuZcId9hkGEHEErL9QPgzGWCeeUB4CKVt/M2ZjFXyQ3A013oe/UauNRtQE+4kSrsj+SjABScRbfs25pnHW7P+eVChqOaLkEYhbOWtUlbsO8dzqIYJRyg1c9mg96Asmixpi88ClJbukV4OkyXgDVE5BxoVlgaPSxNbwK0/+wJPyLRW5e6q+rcDOvh1TuhUThw8gBcU/aUNrbyZJm5bOCjRfeV2JPxSibsfSvOJohovKYRDM61YdmFU0dNYoUpG8lRXGcldhN3Kw4iFwqbHZCUwlJ6j7TJSWWe09k6EGEnKyJVUSCTwrudkpFMlARxcQV09dMUNO5g/7KYMgVODVAn1038KGkVCh2zybR1dCiltJ2LteKR3obR1B+/2u5O5NhLKJ360GuRYLXc2QMfgLsPmNrV9px4e7cBNw0Y64/v4UbIPKy2ccenAx4tV10/hBnwBeFe47zj4V3rwg+8haJ92Fc5L+DrN9ijZSiX90rqAAAAAElFTkSuQmCC","mistral-vibe":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAWlBMVEVHcEzdBAb/ggPfBAT/hQP/lwLbAwjIABrLARf/rgHFABz/hAPGABzEAB37UA//rQH6UA/7Tw/7ggDEAB37UA//ggThBQD/rwH6TQ//gwPgAAD/ngLQAhTiBQB30kzeAAAAEnRSTlMA2XFnXaBUc5lzhNjrpnPc29q2zZkpAAAAvElEQVRYhe2SwQ6CMBBEgVYoBUUjIEX5/99U0mkPa1YNJgbJPi6d2c1rDySJIGwOXYKlC+UFcIId5o0I1iy4Aq11Nn9h8DjPja4w5wRZR4g3++ic84dqsaD7ThARwQuBI0QB6TnBYSC0HloPJ07QfshRBCsWFKOnDwXymCMb5JQT9CAUIUcB8s8FExFMG36Bmjz8C7BABbnxpDeAbBSwZKFGthDYM0O4Yc/MaxGsSJAXDMmbBfX8MwrCv3IHTWBri0Dy7JIAAAAASUVORK5CYII=","amp":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFCUlEQVRYhcWXXWyTZRTHf+dt98H6AYyBM9EY4EqImuBHUGTt1oEEWCsxM2q8RGOCF96ohHhhNES4MUa5EIgXmGiiM+6jIGbrtrYMQc2IEVFjImIiZDCG29qyr/Y9XrTd3pW37eZHPHfv8/+f5/zP8z7nnPcVFmnJFl8XwrAiPcxkej0nTw0vdg+ryWLIY60P1xpTlcOAYVm+iHJcDAm7xhiQaHTyPxOQaGl8AjE/K0GZAE6rasThcERqOvrPCei/JyDoPwS6ZxEuQwoRQ7RHjfSXnvavrhUSDDuvYuaumnpZRLaIyEFgkDLZAfUCz6rKMTLOI3aEoicwviuwwpHJrK7ZED0nr2PacRK7HllFpsIHNAPbgTtKiBlzj0udRKPphQkI+XeL6lFgBOgDImlDupd3RC8V8xnd8egah8PRnBO0DfBYcVOMjUs7+79ekIBE0Pcx8LQNdBGI5AT1LO+Ijtr5q99fnfTqMeDJuWj6mqczvr+sAAVJBn1XgPpiAnOWAb4TkQgQcVUOx6XtwnQeTIYanlGVjyz8Pk9XLFBWwI3W5qUVUzMfAo0UHGMZGwX61eF8ztveO5K7I0OWOJPuqulaaTszkXewrYLatsiYpysWcletWm4YxgOqupfssc+UEbAM2CXpmQBArux+sODVqemqTVYHJ8B4i+9tgYQiPZ4EZ/M3VdraMmTLbRA4eK3V766ZZiPQrKotwDpbGSIB4NPsg/aC3DOLmWYgl0yWqq3rK1NTdTcUXAACKYUzC+lmo483rXWY5hbB3KnIDgt00dMVW5tNzr9TRMN5QOFbb1fsoVkBiZZGH2JGbTPJ2hBwCogYpI+7uk5fKSSo3+9MenUE8ObXMqprloXjvw0HN3mqcY4AFXkok8msXHZi4E8AAzEDhRsWWD3QChw2cV5OBH0XkiH/gWTI36x+fzWARKNpgbjVyYAmgJVdpxOg31ggh+F0+Gd5DtNxWFV3o/IJcL2MGIB1qvqqqvakvJbBpNJrJUn2HthjOocZNcf7LnvD8Q884ehT7g2x2wpu/VQpJYo06PP3Z4/WMHsL4IDmy0+0ANNZASWn4dDWrS7PkkmfacpjCHsAxy0iVDZ7w9EBu+Ylove6O+PntXV9ZXKqbgRw5zGHU+6s+Tz6R8lpWN/dnarpjJ9EtNIuOIAY2pTLRIH+eaBpBACk7cK0Zi8yApeAo1NmtgU4SwlQkGTIdwjlhRKkAPAGgKr2isjc/BANAO8AGIbsMyX9kqd94Jd5CZQMHvS/Z/MBchm4nbkuOp2arKqt7+5OTWxvuivtzFyycBPu+uQKOTJYtIMWfQWpoO+ATfCrOHQL8L1lrdJdPb0ZYMkXfb8Dv1owT+Kq68FiMYoKSLY0vKXwyi3BxWzytMd/UtGIFTCtvURlHmYtuQUJSIR8+1Vkb8HyNdQIeDpP/QhgqFG0rm8tORoXLCARbHgTZV8BZ5iMBDzh/gv5BZcm4szvEfeNt/jrAFSlH/gZ9JCioYkqCZYSMFsFCpIUqS0YO9dFNOA+EbOOVCQ8eDMRbDgL4ssnIqKNQJs3HL0O3F0qqNVmT0BA3Z2xF0Hfzy2NGoaxzd0ZP2/rKdI377nMuy4rYFbEhvgelHcNtMnV0T9YzFGZfxFzNb9oW9SPyTwBNiM4bcjqUl/NdraoHxOrSTSaFiWWe5xEtLfCzHhLOtnt83cFACSCDQ2CUePSRFzCgzf/yV7/m/0F+q8ERSC/Vy4AAAAASUVORK5CYII="};

export function AgentProviderIcon({client,size=16}:{client:string;size?:number}){
 if(client==="shell")return <Icon name="terminal" size={size}/>;
 if(client==="codex")return <OpenAIIcon size={size}/>;
 if(client==="claude-code"||client==="claude-agent-teams")return <ClaudeIcon size={size}/>;
 if(client==="opencode")return <OpenCodeIcon size={size}/>;
 if(client==="pi")return <PiIcon size={size}/>;
 if(client==="kilo")return <KiloIcon size={size}/>;
 if(favicons[client])return <img src={favicons[client]} width={size} height={size} alt="" aria-hidden/>;
 return <AgentLetterIcon letter={(externalProviders.find(item=>item.id===client)?.label??"Agent").charAt(0).toUpperCase()} size={size}/>;
}
