import React from "react";

/**
 * Modal popup.  The OK button auto-focuses on mount and supports Enter
 * to close.  Use the autoClose prop to dismiss after a timeout
 * (e.g. for welcome splash screens).
 */
export default class Popup extends React.Component {

    constructor(props) {
        super(props);
        this.state = { dismissed: false };
    }

    componentDidMount() {
        // Focus the OK button so Enter on the remote closes the popup
        if (this.buttonRef) {
            try { this.buttonRef.focus(); } catch (e) {}
        }
        // Enter / Return key closes the popup
        if (this._onKey) {
            try {
                document.addEventListener("keydown", this._onKey);
            } catch (e) {}
        }
        // Optional auto-dismiss
        if (this.props.autoClose && this.props.autoClose > 0 && !this._autoTimer) {
            this._autoTimer = setTimeout(() => {
                if (this.props.onClose) this.props.onClose();
            }, this.props.autoClose);
        }
    }

    componentWillUnmount() {
        if (this._onKey) {
            try { document.removeEventListener("keydown", this._onKey); } catch (e) {}
        }
        if (this._autoTimer) {
            clearTimeout(this._autoTimer);
        }
    }

    onKeyDown = (e) => {
        // Map Samsung Orsay remote keys
        const k = e.keyCode;
        if (k === 13 /* Enter */ || k === 10009 /* Return */ || k === 27 /* Esc */) {
            if (this.props.onClose) this.props.onClose();
        }
    };

    render() {
        this._onKey = this.onKeyDown;
        return (
            <div className="popup">
                {this.props.children}
                <div className="buttons">
                    <a ref={ref => this.buttonRef = ref}
                       className="button"
                       href="javascript:void(0);"
                       onClick={this.props.onClose}>
                        {this.props.okLabel || "OK"}
                    </a>
                </div>
            </div>)
    }
}
