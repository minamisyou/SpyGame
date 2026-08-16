#!/usr/bin/env python3
"""Lay out the new NIGHT ECHO maps from room rectangles and emit ASCII.

Hand-counting 50-column ASCII rows is error-prone; this builds each grid from
explicit rooms/walls/doors so rows are rectangular by construction. The output
is pasted into src/levels.js as plain string arrays — the game itself keeps no
dependency on this script.
"""

class M:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.g = [['#'] * w for _ in range(h)]
        self.cams = {}      # (x,y) -> config dict

    def rect(self, x0, y0, x1, y1, ch='.'):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.g[y][x] = ch

    def put(self, x, y, ch):
        self.g[y][x] = ch

    def cam(self, x, y, angle, sweep, speed=0.5):
        self.g[y][x] = 'C'
        self.cams[(x, y)] = dict(angle=angle, sweep=sweep, speed=speed)

    def rows(self):
        return [''.join(r) for r in self.g]

    def cam_configs(self):
        """Row-major order — that is how level.js pairs configs to 'C' tiles."""
        out = []
        for y in range(self.h):
            for x in range(self.w):
                if self.g[y][x] == 'C':
                    out.append(self.cams[(x, y)])
        return out


# --------------------------------------------------------------- level 04
def harbor():
    m = M(48, 24)
    m.rect(1, 1, 46, 5)                     # office strip
    m.rect(1, 7, 46, 22)                    # warehouse floor
    for y in range(1, 6):                   # office dividers
        m.g[y][16] = '#'
        m.g[y][32] = '#'
    m.put(16, 3, 'D')
    m.put(32, 3, 'D')
    for x in (8, 24, 40):                   # warehouse <-> offices
        m.put(x, 6, 'D')
    # container stacks = cover
    for (x0, y0) in [(4, 9), (12, 14), (20, 9), (28, 14), (36, 9), (20, 19), (40, 17)]:
        m.rect(x0, y0, x0 + 3, y0 + 2, '#')
    m.put(2, 21, '@')
    m.put(45, 2, 'X')
    for (x, y) in [(3, 3), (24, 21), (44, 12)]:
        m.put(x, y, 'I')
    for (x, y) in [(10, 3), (26, 3), (42, 3), (9, 17), (25, 11), (34, 20), (17, 8)]:
        m.put(x, y, '*')
    m.cam(18, 12, 90, 80, 0.5)
    m.cam(38, 21, 180, 70, 0.45)
    m.put(6, 12, 'A'); m.put(44, 8, 'B'); m.put(30, 21, 'B')
    nodes = {'0': (20, 3), '1': (40, 3), '2': (26, 8), '3': (44, 16),
             '4': (14, 12), '5': (30, 18), '6': (18, 21), '7': (36, 12)}
    for ch, (x, y) in nodes.items():
        m.put(x, y, ch)
    guards = [
        {'route': ['0', '1', '2'], 'speed': 60, 'fov': 76, 'range': 300},
        {'route': ['4', '6', '5'], 'speed': 62, 'fov': 78, 'range': 290},
        {'route': ['7', '3', '5'], 'speed': 64, 'fov': 74, 'range': 310},
        {'route': ['2', '7', '4'], 'speed': 58, 'fov': 80, 'range': 280},
    ]
    return m, guards


# --------------------------------------------------------------- level 05
def glasshouse():
    m = M(46, 26)
    m.rect(1, 1, 44, 24)
    # glass partitions you can see through but not walk through
    for y in range(1, 11):
        m.g[y][14] = '='
        m.g[y][30] = '='
    for x in range(1, 45):
        if x not in (7, 22, 38):
            m.g[12][x] = '=' if x % 2 == 0 else '#'
    m.put(7, 12, 'D'); m.put(22, 12, 'D'); m.put(38, 12, 'D')
    m.put(14, 5, 'D'); m.put(30, 8, 'D')
    # lower wing rooms
    for y in range(14, 25):
        m.g[y][12] = '#'
        m.g[y][32] = '#'
    m.put(12, 18, 'D'); m.put(32, 20, 'D')
    m.rect(18, 16, 26, 20, '#')             # central vault block
    m.put(22, 15, '.')
    m.put(2, 23, '@')
    m.put(43, 2, 'X')
    for (x, y) in [(6, 3), (43, 10), (5, 21), (36, 23)]:
        m.put(x, y, 'I')
    for (x, y) in [(8, 6), (22, 4), (38, 4), (6, 16), (40, 16), (16, 23), (28, 9)]:
        m.put(x, y, '*')
    m.cam(20, 9, 90, 90, 0.55)
    m.cam(8, 14, 0, 70, 0.5)
    m.cam(40, 21, 180, 80, 0.45)
    m.put(2, 15, 'A'); m.put(43, 23, 'B'); m.put(26, 2, 'B')
    nodes = {'0': (20, 3), '1': (36, 8), '2': (5, 8), '3': (22, 23),
             '4': (16, 14), '5': (40, 18), '6': (16, 22), '7': (30, 22), '8': (43, 5)}
    for ch, (x, y) in nodes.items():
        m.put(x, y, ch)
    guards = [
        {'route': ['0', '8', '1'], 'speed': 62, 'fov': 78, 'range': 320},
        {'route': ['2', '0', '4'], 'speed': 58, 'fov': 80, 'range': 290},
        {'route': ['6', '3', '4'], 'speed': 60, 'fov': 76, 'range': 300},
        {'route': ['5', '7', '3'], 'speed': 66, 'fov': 72, 'range': 330},
        {'route': ['1', '5', '7'], 'speed': 64, 'fov': 74, 'range': 300},
    ]
    return m, guards


# --------------------------------------------------------------- level 06
def substation():
    m = M(52, 26)
    m.rect(1, 1, 50, 4)                     # north gallery
    m.rect(1, 6, 50, 11)                    # transformer hall
    m.rect(1, 13, 50, 18)                   # south hall
    m.rect(1, 20, 50, 24)                   # service corridor
    for x in (10, 26, 42):
        m.put(x, 5, 'D'); m.put(x, 12, 'D'); m.put(x, 19, 'D')
    # transformer blocks
    for x0 in (6, 16, 26, 36):
        m.rect(x0, 8, x0 + 4, 9, '#')
        m.rect(x0 + 2, 15, x0 + 6, 16, '#')
    # locked switch room, top right
    for y in range(1, 5):
        m.g[y][43] = '#'
    m.put(43, 2, '+')
    m.put(2, 22, '@')
    m.put(48, 2, 'X')
    for (x, y) in [(48, 16), (3, 8), (24, 22), (30, 2)]:
        m.put(x, y, 'I')
    m.put(20, 22, 'K')
    for (x, y) in [(8, 2), (20, 2), (36, 2), (12, 7), (32, 10), (10, 17), (40, 14), (14, 22), (44, 22)]:
        m.put(x, y, '*')
    m.cam(24, 7, 0, 90, 0.5)
    m.cam(34, 18, 180, 80, 0.5)
    m.cam(6, 13, 0, 70, 0.6)
    m.put(2, 17, 'A'); m.put(46, 8, 'B'); m.put(34, 22, 'B')
    nodes = {'0': (16, 2), '1': (38, 2), '2': (14, 10), '3': (30, 7),
             '4': (46, 10), '5': (18, 13), '6': (34, 17), '7': (48, 22),
             '8': (28, 24), '9': (44, 16)}
    for ch, (x, y) in nodes.items():
        m.put(x, y, ch)
    guards = [
        {'route': ['0', '1', '3'], 'speed': 62, 'fov': 78, 'range': 310},
        {'route': ['2', '5', '6'], 'speed': 60, 'fov': 76, 'range': 300},
        {'route': ['4', '9', '7'], 'speed': 66, 'fov': 74, 'range': 320},
        {'route': ['8', '6', '5'], 'speed': 58, 'fov': 82, 'range': 280},
        {'route': ['3', '4', '1'], 'speed': 64, 'fov': 72, 'range': 330},
    ]
    return m, guards


# --------------------------------------------------------------- level 07
def coldstore():
    m = M(50, 28)
    m.rect(1, 1, 48, 26)
    # freezer aisles: vertical racks with gaps
    for i, x in enumerate(range(6, 45, 6)):
        for y in range(3, 24):
            if (y + i * 3) % 9 in (0, 1):    # staggered gaps
                continue
            m.g[y][x] = '#'
            m.g[y][x + 1] = '#'
    # loading dock band along the bottom
    for x in range(1, 49):
        m.g[24][x] = '#'
    for x in (5, 20, 35, 46):
        m.put(x, 24, 'D')
    m.rect(1, 25, 48, 26)
    m.put(2, 26, '@')
    m.put(47, 2, 'X')
    for (x, y) in [(3, 3), (47, 13), (26, 26), (16, 2)]:
        m.put(x, y, 'I')
    for (x, y) in [(10, 5), (22, 9), (34, 5), (14, 18), (40, 20), (28, 15), (4, 12), (44, 8)]:
        m.put(x, y, '*')
    m.cam(20, 12, 90, 100, 0.5)
    m.cam(38, 22, 180, 80, 0.45)
    m.cam(9, 21, 0, 70, 0.55)
    m.put(2, 20, 'A'); m.put(47, 26, 'B'); m.put(31, 2, 'B'); m.put(44, 26, 'A')
    nodes = {'0': (14, 3), '1': (32, 3), '2': (44, 4), '3': (26, 11),
             '4': (12, 12), '5': (38, 12), '6': (20, 20), '7': (44, 18),
             '8': (14, 25), '9': (40, 26), 'a': (30, 22)}
    for ch, (x, y) in nodes.items():
        m.put(x, y, ch)
    guards = [
        {'route': ['0', '1', '2'], 'speed': 62, 'fov': 78, 'range': 300},
        {'route': ['3', '4', '6'], 'speed': 60, 'fov': 76, 'range': 300},
        {'route': ['5', '7', '9'], 'speed': 64, 'fov': 74, 'range': 320},
        {'route': ['8', '6', 'a'], 'speed': 58, 'fov': 80, 'range': 280},
        {'route': ['a', '5', '3'], 'speed': 66, 'fov': 72, 'range': 330},
        {'route': ['2', '7', '5'], 'speed': 62, 'fov': 76, 'range': 310},
    ]
    return m, guards


# --------------------------------------------------------------- level 08
def spire():
    m = M(44, 30)
    # four stacked floors joined by stairwells at alternating ends
    bands = [(1, 5), (8, 12), (15, 19), (22, 28)]
    for (y0, y1) in bands:
        m.rect(1, y0, 42, y1)
    # stairwells
    m.rect(2, 6, 5, 7); m.rect(37, 13, 40, 14); m.rect(2, 20, 5, 21)
    # inner partitions per floor
    for y in range(1, 6):
        m.g[y][18] = '#'
    m.put(18, 3, 'D')
    for y in range(8, 13):
        m.g[y][26] = '#'
    m.put(26, 10, 'D')
    for y in range(15, 20):
        m.g[y][14] = '#'
    m.put(14, 17, 'D')
    for y in range(22, 29):
        m.g[y][22] = '#'
    m.put(22, 25, 'D')
    m.put(2, 27, '@')
    m.put(40, 2, 'X')
    for (x, y) in [(8, 2), (34, 10), (6, 17), (38, 27)]:
        m.put(x, y, 'I')
    for (x, y) in [(24, 3), (12, 10), (32, 17), (10, 25), (36, 4), (20, 11), (28, 24)]:
        m.put(x, y, '*')
    m.cam(30, 2, 180, 80, 0.5)
    m.cam(8, 11, 0, 90, 0.55)
    m.cam(24, 18, 180, 70, 0.5)
    m.cam(14, 27, 0, 90, 0.45)
    m.put(41, 17, 'A'); m.put(2, 10, 'B'); m.put(30, 27, 'B')
    nodes = {'0': (12, 3), '1': (30, 4), '2': (10, 9), '3': (22, 11),
             '4': (38, 9), '5': (8, 16), '6': (26, 16), '7': (40, 18),
             '8': (16, 24), '9': (34, 24), 'a': (26, 27), 'b': (12, 23)}
    for ch, (x, y) in nodes.items():
        m.put(x, y, ch)
    guards = [
        {'route': ['0', '1', '3'], 'speed': 62, 'fov': 78, 'range': 300},
        {'route': ['2', '4', '3'], 'speed': 60, 'fov': 76, 'range': 300},
        {'route': ['5', '6', '7'], 'speed': 64, 'fov': 74, 'range': 310},
        {'route': ['8', '9', 'a'], 'speed': 62, 'fov': 78, 'range': 300},
        {'route': ['b', '8', 'a'], 'speed': 58, 'fov': 82, 'range': 280},
        {'route': ['9', '7', '6'], 'speed': 66, 'fov': 72, 'range': 330},
    ]
    return m, guards


# --------------------------------------------------------------- level 09
def deepwell():
    m = M(54, 30)
    m.rect(1, 1, 52, 28)
    # ring of side rooms around an open lab floor
    for x in range(1, 53):
        m.g[7][x] = '#'
        m.g[21][x] = '#'
    for x in (6, 20, 34, 48):
        m.put(x, 7, 'D'); m.put(x, 21, 'D')
    for y in range(1, 7):
        m.g[y][13] = '#'; m.g[y][27] = '#'; m.g[y][41] = '#'
    for y in range(22, 29):
        m.g[y][13] = '#'; m.g[y][27] = '#'; m.g[y][41] = '#'
    m.put(13, 4, 'D'); m.put(27, 4, 'D'); m.put(41, 4, 'D')
    m.put(13, 25, 'D'); m.put(27, 25, 'D'); m.put(41, 25, 'D')
    # central vault, keycard locked
    m.rect(22, 11, 32, 17, '#')
    m.rect(24, 13, 30, 15)
    m.put(27, 12, '.')                      # airlock tile behind the vault door
    m.put(27, 11, '+')
    # glass observation wall
    for x in range(36, 47):
        m.g[14][x] = '='
    m.put(2, 27, '@')
    m.put(50, 2, 'X')
    for (x, y) in [(4, 4), (24, 14), (50, 27), (18, 27)]:
        m.put(x, y, 'I')
    m.put(46, 4, 'K')
    for (x, y) in [(8, 3), (20, 3), (36, 3), (10, 10), (44, 10), (16, 19), (40, 19), (8, 25), (34, 25)]:
        m.put(x, y, '*')
    m.cam(18, 9, 0, 90, 0.5)
    m.cam(38, 19, 180, 90, 0.5)
    m.cam(6, 14, 0, 70, 0.6)
    m.cam(48, 14, 180, 70, 0.55)
    m.put(2, 14, 'A'); m.put(50, 19, 'B'); m.put(34, 4, 'B'); m.put(4, 19, 'A')
    nodes = {'0': (8, 5), '1': (22, 5), '2': (36, 5), '3': (50, 5),
             '4': (12, 10), '5': (18, 17), '6': (36, 10), '7': (46, 17),
             '8': (20, 27), '9': (32, 27), 'a': (44, 27), 'b': (48, 24),
             'c': (30, 19), 'd': (14, 14)}
    for ch, (x, y) in nodes.items():
        m.put(x, y, ch)
    guards = [
        {'route': ['0', '1', '2'], 'speed': 62, 'fov': 78, 'range': 310},
        {'route': ['3', '2', '6'], 'speed': 64, 'fov': 74, 'range': 320},
        {'route': ['4', 'd', '5'], 'speed': 60, 'fov': 76, 'range': 300},
        {'route': ['6', '7', 'c'], 'speed': 66, 'fov': 72, 'range': 330},
        {'route': ['8', '9', 'a'], 'speed': 60, 'fov': 78, 'range': 300},
        {'route': ['b', 'a', 'c'], 'speed': 62, 'fov': 76, 'range': 310},
        {'route': ['5', 'c', 'd'], 'speed': 58, 'fov': 82, 'range': 280},
    ]
    return m, guards


# --------------------------------------------------------------- level 10
def lastlight():
    m = M(56, 32)
    m.rect(1, 1, 54, 30)
    # spine corridors
    for x in range(1, 55):
        m.g[9][x] = '#'
        m.g[21][x] = '#'
    for x in (8, 24, 40, 51):
        m.put(x, 9, 'D')
    for x in (12, 28, 44):
        m.put(x, 21, 'D')
    # upper cell rooms
    for y in range(1, 9):
        for x in (14, 28, 42):
            m.g[y][x] = '#'
    m.put(14, 5, 'D'); m.put(28, 5, '+'); m.put(42, 5, 'D')
    # middle machine floor with pillars + glass gallery
    for x0 in (6, 16, 26, 36, 46):
        m.rect(x0, 13, x0 + 3, 15, '#')
    for x in range(18, 30):
        m.g[18][x] = '='
    # lower wing
    for y in range(22, 31):
        m.g[y][18] = '#'; m.g[y][36] = '#'
    m.put(18, 26, 'D'); m.put(36, 26, 'D')
    m.put(2, 29, '@')
    m.put(52, 2, 'X')
    for (x, y) in [(4, 4), (34, 4), (52, 19), (8, 19), (28, 29)]:
        m.put(x, y, 'I')
    m.put(6, 24, 'K')
    for (x, y) in [(8, 3), (22, 3), (48, 3), (12, 11), (44, 11), (30, 19), (10, 27), (46, 27), (26, 24)]:
        m.put(x, y, '*')
    m.cam(20, 11, 0, 100, 0.45)
    m.cam(38, 19, 180, 100, 0.45)
    m.cam(6, 15, 0, 80, 0.6)
    m.cam(50, 15, 180, 80, 0.6)
    m.cam(27, 29, 90, 90, 0.5)
    m.put(52, 11, 'A'); m.put(2, 11, 'B'); m.put(30, 8, 'A'); m.put(50, 29, 'B')
    nodes = {'0': (8, 6), '1': (20, 6), '2': (36, 6), '3': (50, 6),
             '4': (10, 12), '5': (24, 12), '6': (34, 16), '7': (48, 12),
             '8': (14, 19), '9': (44, 19), 'a': (10, 24), 'b': (28, 24),
             'c': (46, 24), 'd': (24, 29), 'e': (40, 29), 'f': (52, 24)}
    for ch, (x, y) in nodes.items():
        m.put(x, y, ch)
    guards = [
        {'route': ['0', '1', '5'], 'speed': 64, 'fov': 78, 'range': 310},
        {'route': ['2', '3', '7'], 'speed': 66, 'fov': 74, 'range': 330},
        {'route': ['4', '8', 'a'], 'speed': 62, 'fov': 76, 'range': 300},
        {'route': ['6', '9', 'c'], 'speed': 68, 'fov': 72, 'range': 340},
        {'route': ['b', 'd', 'a'], 'speed': 60, 'fov': 80, 'range': 290},
        {'route': ['e', 'c', 'f'], 'speed': 64, 'fov': 76, 'range': 310},
        {'route': ['5', '6', '9'], 'speed': 66, 'fov': 74, 'range': 320},
        {'route': ['1', '4', '8'], 'speed': 58, 'fov': 82, 'range': 280},
    ]
    return m, guards


BRIEFS = {'l4': '세관 창고에 반입된 밀수 화물의 선적 기록을 확보한다. 컨테이너 더미가 좋은 엄폐물이지만, 통로는 길고 곧다 — 한번 시야에 걸리면 숨을 곳까지 거리가 멀다.', 'l5': '유리로 나뉜 저택. 벽 너머가 그대로 보인다는 건, 저쪽에서도 이쪽이 보인다는 뜻이다. 유리는 지나갈 수 없으니 우회로를 미리 읽어둘 것.', 'l6': '변전소의 계통 제어 기록을 빼낸다. 조명이 많아 어둠이 귀하다. 개폐실은 키카드로 잠겨 있고, 순찰조는 세 개 층을 오간다.', 'l7': '냉동 창고. 좁은 통로가 격자로 얽혀 있어 시야는 짧지만, 한번 마주치면 피할 공간도 없다. 적재 선반 사이의 엇갈린 틈을 이용하라.', 'l8': '첨탑을 아래에서 위로 훑는다. 층 사이를 잇는 계단은 양 끝에 하나씩뿐이라 퇴로가 좁다. 경비 여섯이 각 층을 맡고 있다.', 'l9': '지하 연구소. 중앙 금고는 키카드 없이 열리지 않고, 관측용 유리벽 너머로 시선이 통한다. 경비 일곱, 카메라 넷.', 'l10': '마지막 임무. 통제실을 장악하고 자료 다섯 건을 모두 회수한다. 조명은 적지만 경비는 여덟이고, 카메라가 모든 길목을 훑는다. 실수는 한 번도 허용되지 않는다.'}

META = [
    ('l4', 'HARBOR WATCH', '항만 세관 / THE DOCKS', 0.15, 6, 3, harbor, None),
    ('l5', 'GLASS HOUSE', '유리 저택 / THE VILLA', 0.14, 6, 3, glasshouse, None),
    ('l6', 'SUBSTATION', '변전소 / GRID NODE', 0.13, 7, 3, substation, '개폐실 (키카드 필요)'),
    ('l7', 'COLD STORAGE', '냉동 창고 / DEEP FREEZE', 0.12, 7, 4, coldstore, None),
    ('l8', 'THE SPIRE', '첨탑 / VERTICAL RUN', 0.12, 7, 3, spire, None),
    ('l9', 'DEEP WELL', '지하 연구소 / THE WELL', 0.11, 8, 4, deepwell, '중앙 금고 (키카드 필요)'),
    ('l10', 'LAST LIGHT', '마지막 불빛 / BLACKOUT', 0.10, 8, 4, lastlight, '통제실 (키카드 필요)'),
]

if __name__ == '__main__':
    import sys
    show = '--show' in sys.argv
    for (lid, name, code, amb, ammo, bottles, fn, hint) in META:
        m, guards = fn()
        rows = m.rows()
        if show:
            print(f'--- {lid} {name}  {m.w}x{m.h}')
            for r in rows:
                print(r)
            print()
        else:
            print(f'  // ===== {lid} {name} ({m.w}x{m.h}) =====')
            print(f"  {{ id: '{lid}', name: '{name}', codename: '{code}',")
            print(f"    brief:")
            print(f"      '{BRIEFS[lid]}',")
            print(f'    ambient: {amb}, startAmmo: {ammo}, startBottles: {bottles},')
            print('    map: [')
            for r in rows:
                print(f"      '{r}',")
            print('    ],')
            print('    guards: [')
            for g in guards:
                print(f"      {{ route: {g['route']}, speed: {g['speed']}, fov: {g['fov']}, range: {g['range']} }},".replace("'", "'"))
            print('    ],')
            print('    cams: [')
            for c in m.cam_configs():
                print(f"      {{ angle: {c['angle']}, sweep: {c['sweep']}, speed: {c['speed']} }},")
            print('    ],')
            if hint:
                print(f"    lockedDoorHint: '{hint}',")
            print('  },')
