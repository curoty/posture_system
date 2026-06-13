from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import FancyArrowPatch, Polygon, Rectangle


COLORS = {
    "input": "#D9D9D9",
    "conv": "#6FA8DC",
    "bnrelu": "#93C47D",
    "dropout": "#F6B26B",
    "pool": "#FFD966",
    "lstm": "#8E7CC3",
    "attention": "#C27BA0",
    "fc": "#76A5AF",
    "softmax": "#E06666",
    "text": "#222222",
    "border": "#666666",
    "arrow": "#222222",
}


@dataclass(frozen=True)
class LayerSpec:
    label: str
    color_key: str
    param_text: str = ""
    width: float = 0.62


def draw_3d_block(ax, x, y, w, h, color, depth=0.08, label=None, show_label=False, fontsize=7.0):
    # front
    front = Rectangle(
        (x, y), w, h,
        facecolor=color,
        edgecolor="black",
        linewidth=0.85
    )
    ax.add_patch(front)

    # top
    top = Polygon(
        [
            [x, y + h],
            [x + depth, y + h + depth],
            [x + w + depth, y + h + depth],
            [x + w, y + h],
        ],
        closed=True,
        facecolor=color,
        edgecolor="black",
        linewidth=0.75,
        alpha=0.92,
    )
    ax.add_patch(top)

    # side
    side = Polygon(
        [
            [x + w, y],
            [x + w + depth, y + depth],
            [x + w + depth, y + h + depth],
            [x + w, y + h],
        ],
        closed=True,
        facecolor=color,
        edgecolor="black",
        linewidth=0.75,
        alpha=0.82,
    )
    ax.add_patch(side)

    if show_label and label:
        ax.text(
            x + w / 2,
            y + h / 2,
            label,
            ha="center",
            va="center",
            fontsize=fontsize,
            color=COLORS["text"],
            fontweight="semibold",
        )

    return x + w + depth, y + h / 2


def draw_arrow(ax, x1, y1, x2, y2):
    ax.add_patch(
        FancyArrowPatch(
            (x1, y1),
            (x2, y2),
            arrowstyle="-|>",
            mutation_scale=9,
            linewidth=1.1,
            color=COLORS["arrow"],
            shrinkA=0,
            shrinkB=0,
        )
    )


def draw_module(ax, x, y, w, h, title):
    rect = Rectangle(
        (x, y),
        w,
        h,
        fill=False,
        linestyle=(0, (4, 4)),
        linewidth=0.95,
        edgecolor=COLORS["border"],
    )
    ax.add_patch(rect)

    ax.text(
        x + w / 2,
        y + h + 0.12,
        title,
        ha="center",
        va="bottom",
        fontsize=9.8,
        fontweight="bold",
        color=COLORS["text"],
    )


def draw_param_text(ax, x, y, w, text, fontsize=6.5):
    if not text:
        return
    ax.text(
        x + w / 2,
        y - 0.10,
        text,
        ha="center",
        va="top",
        fontsize=fontsize,
        color=COLORS["text"],
        linespacing=0.95,
    )


def build_figure(output_path: Path, dpi: int, show_block_labels: bool = False) -> None:
    # -------- 三个模块内容 --------
    module1 = [
        LayerSpec("Input", "input", "64×54", 0.64),
        LayerSpec("Conv1D", "conv", "k=5\nc=64", 0.62),
        LayerSpec("BN+ReLU", "bnrelu", "", 0.60),
    ]

    module2 = [
        LayerSpec("Dropout", "dropout", "p=0.15", 0.56),
        LayerSpec("Conv1D", "conv", "k=5\nc=128", 0.62),
        LayerSpec("BN+ReLU", "bnrelu", "", 0.60),
        LayerSpec("MaxPool1D", "pool", "s=2", 0.62),
        LayerSpec("Conv1D", "conv", "k=3\nc=128", 0.62),
        LayerSpec("BN+ReLU", "bnrelu", "", 0.60),
        LayerSpec("Dropout", "dropout", "p=0.21", 0.56),
        LayerSpec("BiLSTM", "lstm", "h=128\nbi\nout=256", 0.68),
        LayerSpec("Attention", "attention", "additive", 0.68),
        LayerSpec("ReLU", "bnrelu", "", 0.50),
    ]

    module3 = [
        LayerSpec("Dropout", "dropout", "p=0.30", 0.56),
        LayerSpec("FC", "fc", "128→N", 0.54),
        LayerSpec("Softmax", "softmax", "prob.", 0.64),
    ]

    modules = [
        ("Module 1: Temporal Feature Extraction", module1),
        ("Module 2: Sequence Modeling & Attention", module2),
        ("Module 3: Classification Head", module3),
    ]

    # -------- 更紧凑的版式参数 --------
    block_h = 0.46
    block_y = 2.25
    depth = 0.08
    block_gap = 0.07
    module_pad = 0.16
    module_gap = 0.22
    left_margin = 0.42

    module_boxes = []
    placed_blocks = []

    # -------- 先计算位置 --------
    x = left_margin
    for module_title, layer_list in modules:
        bx = x + module_pad
        current_blocks = []

        for layer in layer_list:
            left_x = bx
            right_x = bx + layer.width + depth
            current_blocks.append((left_x, right_x, layer))
            bx = right_x + block_gap

        module_x0 = current_blocks[0][0] - module_pad
        module_x1 = current_blocks[-1][1] + module_pad
        module_boxes.append((module_x0, module_x1, module_title, current_blocks))
        x = module_x1 + module_gap

    total_width = module_boxes[-1][1] + 0.35

    # -------- 画布：比上一版更紧凑 --------
    fig, ax = plt.subplots(figsize=(16.5, 4.4))
    fig.patch.set_facecolor("white")
    ax.set_facecolor("white")
    ax.set_xlim(0, total_width)
    ax.set_ylim(0, 4.4)
    ax.axis("off")

    # -------- 总标题 --------
    ax.text(
        total_width / 2,
        4.02,
        "1D-CNN + BiLSTM + Additive Self-Attention Classifier",
        ha="center",
        va="center",
        fontsize=15,
        fontweight="bold",
        color=COLORS["text"],
    )

    # -------- 模块框 --------
    module_y = 1.18
    module_h = 1.82

    for module_x0, module_x1, module_title, current_blocks in module_boxes:
        draw_module(ax, module_x0, module_y, module_x1 - module_x0, module_h, module_title)

        for left_x, _, layer in current_blocks:
            right_x, cy = draw_3d_block(
                ax,
                left_x,
                block_y,
                layer.width,
                block_h,
                COLORS[layer.color_key],
                depth=depth,
                label=layer.label,
                show_label=show_block_labels,  # 默认 False：不显示类型
                fontsize=6.8,
            )

            # 参数显示在块下方
            draw_param_text(ax, left_x, block_y, layer.width, layer.param_text, fontsize=6.4)
            placed_blocks.append((left_x, right_x, cy, layer))

    # -------- 箭头 --------
    for i in range(len(placed_blocks) - 1):
        _, right_x, cy, _ = placed_blocks[i]
        next_x, _, _, _ = placed_blocks[i + 1]
        draw_arrow(ax, right_x + 0.02, cy, next_x - 0.02, cy)

    # 仅保留简短输入/输出文字
    first_left, _, _, _ = placed_blocks[0]
    last_left, _, _, _ = placed_blocks[-1]

    ax.text(
        first_left + 0.32,
        block_y - 0.32,
        "Input",
        ha="center",
        va="top",
        fontsize=7.2,
        color=COLORS["text"],
    )
    ax.text(
        last_left + 0.32,
        block_y - 0.32,
        "Output",
        ha="center",
        va="top",
        fontsize=7.2,
        color=COLORS["text"],
    )

    # -------- Legend --------
    legend_handles = [
        Rectangle((0, 0), 1, 1, facecolor=COLORS["input"], edgecolor="black", label="Input"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["conv"], edgecolor="black", label="Conv1D"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["bnrelu"], edgecolor="black", label="BN / ReLU"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["dropout"], edgecolor="black", label="Dropout"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["pool"], edgecolor="black", label="Pooling"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["lstm"], edgecolor="black", label="BiLSTM"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["attention"], edgecolor="black", label="Attention"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["fc"], edgecolor="black", label="Fully Connected"),
        Rectangle((0, 0), 1, 1, facecolor=COLORS["softmax"], edgecolor="black", label="Softmax / Output"),
        Line2D([0], [0], color=COLORS["arrow"], lw=1.1, label="Data Flow"),
    ]

    ax.legend(
        handles=legend_handles,
        loc="lower center",
        bbox_to_anchor=(0.5, 0.03),
        ncol=5,
        frameon=False,
        fontsize=8.2,
        handlelength=1.4,
        columnspacing=0.9,
        handletextpad=0.45,
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    plt.subplots_adjust(left=0.02, right=0.99, top=0.96, bottom=0.10)
    plt.savefig(output_path, dpi=dpi, facecolor="white")
    plt.close(fig)


def parse_args():
    parser = argparse.ArgumentParser(description="Draw a compact architecture diagram with legend and parameter annotations.")
    parser.add_argument(
        "--output",
        default="experiments/model_architecture_compact_params.png",
        help="Output file path, e.g. png/svg/pdf",
    )
    parser.add_argument("--dpi", type=int, default=220)
    parser.add_argument(
        "--show-block-labels",
        action="store_true",
        help="Show layer names inside blocks. Default: False",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    build_figure(
        output_path=Path(args.output),
        dpi=args.dpi,
        show_block_labels=args.show_block_labels,
    )
    print(f"Saved architecture diagram to: {Path(args.output).resolve()}")


if __name__ == "__main__":
    main()